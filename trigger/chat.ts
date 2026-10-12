import { chat } from "@trigger.dev/sdk/ai"
import {
  generateId,
  generateText,
  hasToolCall,
  stepCountIs,
  type InferUITools,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from "ai"
import { z } from "zod"

import { db } from "@/db"
import {
  getChatModel,
  MAX_AGENT_STEPS,
  streamErrorText,
  thinkingOptions,
} from "@/lib/ai"
import { buildAutoPrompt, buildBotPrompt } from "@/lib/bot-prompt"
import { summaryMessage } from "@/lib/compaction"
import { AUTO_BOT_ID, AUTO_BOT_NAME } from "@/lib/group-chat"
import { createHandoffTool, type HandoffTools } from "@/lib/handoff"
import {
  createSandboxTools,
  pruneScreenshots,
  type SandboxTools,
} from "@/lib/sandbox-tools"
import { transcriptStorage } from "@/lib/transcript-storage"

// Context size at which the history is summarised. Well under the model's
// window, since answers degrade long before it fills
const COMPACT_AT_TOKENS = 80_000

const SUMMARY_REQUEST = `Summarise the conversation so far for yourself, to carry on from it with the earlier messages gone. Keep what the user wants and any instructions they gave, what has been done and found, decisions made, and where things stand now: open pages, files, logins and anything left to do. Write it as notes, not a reply to the user.`

// Thinking is switched off: a summary needs none and it would only be cut
async function summarizeHistory(
  messages: ModelMessage[],
  abortSignal?: AbortSignal
) {
  const result = await generateText({
    model: getChatModel(),
    abortSignal,
    messages: [
      ...pruneScreenshots(messages),
      { role: "user", content: SUMMARY_REQUEST },
    ],
    providerOptions: {
      freellm: { chat_template_kwargs: { enable_thinking: false } },
    },
  })
  return result.text
}

// Streamed, not kept, while the history is summarised. The runtime sends
// status and totalTokens when it compacts on its own; /compact adds the
// summary it left so the chat can show it without reloading
export type CompactionData = {
  status: "compacting" | "complete"
  totalTokens?: number
  summary?: { id: string; text: string }
}

// Which bot wrote a reply, so group chats can show who answered: a bot's ID,
// or AUTO_BOT_ID. Bots a reply handed off to are named in its handoff parts
export type ChatMessageMetadata = { botId?: string }

export type ChatUIMessage = UIMessage<
  ChatMessageMetadata,
  { compaction: CompactionData },
  InferUITools<SandboxTools & HandoffTools>
>

// How many bots Auto can hand one message to before it has to wrap up
const MAX_AUTO_HANDOFFS = 5

// Who answers this turn: the bot picked in a group chat, or else the chat's
// first, which is a direct chat's only bot. Auto, which only group chats have,
// leaves `bot` unset. The pick comes from the browser, so it has to be Auto
// or one of the chat's own bots
async function getChatBots(chatId: string, botId?: string) {
  const row = await db.query.chats.findFirst({
    where: (chat, { eq }) => eq(chat.id, chatId),
    columns: { kind: true },
    with: {
      members: {
        orderBy: (member, { asc }) => [asc(member.joinedAt)],
        with: { bot: true },
      },
    },
  })
  const bots = row?.members.map((member) => member.bot) ?? []
  const isGroup = row?.kind === "group"
  if (isGroup && botId === AUTO_BOT_ID) {
    return { bot: undefined, bots, isGroup }
  }
  const bot = botId ? bots.find((bot) => bot.id === botId) : bots[0]
  if (!bot) {
    throw new Error(
      botId
        ? `Bot ${botId} isn't in chat ${chatId}`
        : `No bot found for chat ${chatId}`
    )
  }
  return { bot, bots, isGroup }
}

// The turn's tools. In a group chat the picked bot can hand off to the
// others, and Auto to any of them. Auto can't use a sandbox, but keeps the
// first bot's tools for converting earlier turns, and run turns them off
function createChatTools({
  chatId,
  bot,
  bots,
  isGroup,
}: Awaited<ReturnType<typeof getChatBots>> & { chatId: string }): ToolSet {
  const sandboxTools = createSandboxTools({
    chatId,
    sandboxId: (bot ?? bots[0]).sandboxId,
  })
  if (!isGroup) {
    return sandboxTools
  }
  const handoff = bot
    ? createHandoffTool({
        chatId,
        from: bot.name,
        members: bots,
        targets: bots.filter((target) => target.id !== bot.id),
        description:
          "Hand the person's message to another bot whose job fits it better. That bot answers the person in your place, and your turn ends.",
      })
    : createHandoffTool({
        chatId,
        from: AUTO_BOT_NAME,
        members: bots,
        targets: bots,
        description:
          "Hand the person's message, or one part of it, to a bot. The bot works on it in its own sandbox and replies to the person, and you get its reply back.",
      })
  return { ...sandboxTools, handoff }
}

// One long-lived run per chat. History is kept in Neon by transcriptStorage,
// keyed by chatId, so every Trigger.dev environment sees the same chats, and
// read back by loadChatTranscript
export const chatAgent = chat.withUIMessage<ChatUIMessage>().agent({
  id: "chat",
  storage: transcriptStorage,
  // Sent with every message, so each turn can go to a different bot
  clientDataSchema: z.object({ botId: z.string().optional() }),
  uiMessageStreamOptions: {
    // Stream the model's thinking so the chat can show it, collapsed
    sendReasoning: true,
    // Also names tool failures in the chat. Logged in full
    onError: (error) => {
      console.error("Chat stream error", error)
      return streamErrorText(error)
    },
  },
  // Declared here, not only on streamText, so viewScreen's toModelOutput is
  // re-applied when earlier turns are converted back for the model
  tools: async ({ chatId, clientData }) =>
    createChatTools({
      chatId,
      ...(await getChatBots(chatId, clientData?.botId)),
    }),
  // Messages sent while a reply streams join it at the next step boundary
  // rather than starting a turn of their own
  pendingMessages: {
    shouldInject: () => true,
  },
  // Once the context grows past the threshold, the model gets a summary in
  // place of the earlier turns. The chat still shows them all.
  // Only between turns here: the managed mid-turn compaction rebuilds from
  // each step's response.messages, which AI SDK 7 trims to the step's own, so
  // run's prepareStep compacts mid-turn itself
  compaction: {
    shouldCompact: ({ source, totalTokens }) =>
      source === "outer" && (totalTokens ?? 0) > COMPACT_AT_TOKENS,
    summarize: ({ messages }) => summarizeHistory(messages),
  },
  // Commands typed in the chat rather than sent to the model
  actionSchema: z.discriminatedUnion("type", [
    z.object({ type: z.literal("clear") }),
    z.object({ type: z.literal("compact") }),
  ]),
  // The storage is handed what these change, so a reload shows what they
  // leave too
  onAction: async ({ action, messages }) => {
    // Starts the model afresh once a long chat crowds its context
    if (action.type === "clear") {
      chat.history.set([])
    }
    // Like clear, but the summary carries the conversation on
    if (action.type === "compact" && messages.length > 0) {
      const chunkId = generateId()
      await chat.stream.append({
        type: "data-compaction",
        id: chunkId,
        data: { status: "compacting" } satisfies CompactionData,
        transient: true,
      })
      const summary = {
        id: generateId(),
        text: await summarizeHistory(messages),
      }
      chat.history.set([summaryMessage(summary.id, summary.text)])
      await chat.stream.append({
        type: "data-compaction",
        id: chunkId,
        data: { status: "complete", summary } satisfies CompactionData,
        transient: true,
      })
    }
  },
  // Set every turn rather than once per run, so edits to the bot apply to the
  // next message, continuation runs get the prompt too, and a group chat
  // speaks as whichever bot was picked for this message, or as Auto
  onTurnStart: async ({ chatId, clientData }) => {
    const { bot, bots, isGroup } = await getChatBots(chatId, clientData?.botId)
    chat.prompt.set(
      bot
        ? buildBotPrompt(
            bot,
            isGroup
              ? { mates: bots.filter((mate) => mate.id !== bot.id) }
              : undefined
          )
        : buildAutoPrompt(bots, MAX_AUTO_HANDOFFS)
    )
    chat.setUIMessageStreamOptions({
      messageMetadata: () =>
        ({ botId: bot?.id ?? AUTO_BOT_ID }) satisfies ChatMessageMetadata,
    })
  },
  // streamText comes from the run argument so the managed options apply,
  // including the system prompt set above
  run: async ({ messages, tools, clientData, signal, streamText }) => {
    const isAuto = clientData?.botId === AUTO_BOT_ID
    // Auto only hands off, and once it has used up its handoffs it can only
    // wrap up. A bot keeps all of its tools
    const activeTools = (handoffs: number) =>
      isAuto
        ? handoffs < MAX_AUTO_HANDOFFS
          ? ["handoff" as const]
          : []
        : undefined

    // Steering messages, by the step they were injected after. The managed
    // prepareStep appends them to the messages it hands ours, which rebuilds
    // the history and would otherwise drop them
    const steered = new Map<number, ModelMessage[]>()
    const known = new Set<ModelMessage>(messages)

    return streamText({
      model: getChatModel(),
      messages,
      tools,
      abortSignal: signal,
      activeTools: activeTools(0),
      // A bot that hands off is done: the bot it handed to has answered
      stopWhen: isAuto
        ? stepCountIs(MAX_AGENT_STEPS)
        : [stepCountIs(MAX_AGENT_STEPS), hasToolCall("handoff")],
      // Rebuilt from every step rather than taken from the argument: the SDK's
      // managed prepareStep (4.7.3) expects each step's response.messages to
      // hold all earlier steps too, as in AI SDK 5/6. AI SDK 7 gives each step
      // only its own, so from the third step on the model would never see
      // another tool result, and would repeat the same call forever
      prepareStep: async ({ messages: current, steps }) => {
        // Steps only add assistant and tool messages, so a user message not
        // seen before was injected at this boundary. After a compaction the
        // managed prepareStep leads with a fresh copy of the summary, which
        // isn't one
        const summary = chat.getCompactionState()?.summary
        const injected = current.filter(
          (message) =>
            message.role === "user" &&
            !known.has(message) &&
            message.content !== summary
        )
        if (injected.length > 0) {
          injected.forEach((message) => known.add(message))
          steered.set(steps.length - 1, injected)
        }
        const handoffs = steps
          .flatMap((step) => step.toolCalls)
          .filter((call) => call.toolName === "handoff").length
        const stepMessages = (from: number) =>
          steps
            .slice(from)
            .flatMap((step, i) => [
              ...step.response.messages,
              ...(steered.get(from + i) ?? []),
            ])

        // A long turn of tool calls can outgrow the model's context before
        // the turn ends and the history is compacted, so it is summarised
        // here too, once per turn: chat.compact keeps the first summary, and
        // hands it and the steps after it on to the next turn. It streams the
        // progress too. A failed summary leaves the history as it was
        const history = pruneScreenshots([
          ...messages,
          // Arrived before the first step
          ...(steered.get(-1) ?? []),
          ...stepMessages(0),
        ])
        if (summary === undefined) {
          try {
            await chat.compact(history, steps, {
              threshold: COMPACT_AT_TOKENS,
              summarize: (toSummarize) => summarizeHistory(toSummarize, signal),
            })
          } catch (error) {
            console.error("Chat compaction failed", error)
          }
        }

        // The summary stands in for every step it covers
        const compaction = chat.getCompactionState()
        return {
          activeTools: activeTools(handoffs),
          messages: compaction
            ? pruneScreenshots([
                {
                  role: "user",
                  content: `[Conversation summary]\n\n${compaction.summary}\n\nCarry on from here.`,
                },
                ...stepMessages(compaction.baseResponseStepCount),
              ])
            : history,
        }
      },
      ...thinkingOptions,
    })
  },
})
