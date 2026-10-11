import { chat } from "@trigger.dev/sdk/ai"
import {
  generateId,
  generateText,
  stepCountIs,
  type InferUITools,
  type ModelMessage,
  type UIMessage,
} from "ai"
import { z } from "zod"

import { db } from "@/db"
import { getChatModel } from "@/lib/ai"
import { buildBotPrompt } from "@/lib/bot-prompt"
import { summaryMessage } from "@/lib/compaction"
import {
  createSandboxTools,
  pruneScreenshots,
  type SandboxTools,
} from "@/lib/sandbox-tools"

// Qwen3 thinks before every reply and tool call, and acts better for it. The
// server returns the thinking as `reasoning`, which the provider streams as
// reasoning parts and sends back as `reasoning_content` on the next step, so
// each step's thinking follows the tool results it saw.
// Sampling follows Qwen's recommendation for thinking mode
const thinkingOptions = {
  temperature: 0.6,
  topP: 0.95,
  providerOptions: {
    freellm: {
      // Not in the AI SDK's call options, so passed straight to the server
      top_k: 20,
      min_p: 0,
      chat_template_kwargs: { enable_thinking: true },
      // One action per step, so the next one is decided after seeing the
      // result of this one rather than blind
      parallel_tool_calls: false,
    },
  },
}

// Context size at which the history is summarised. Well under the model's
// window, since answers degrade long before it fills
const COMPACT_AT_TOKENS = 80_000

const SUMMARY_REQUEST = `Summarise the conversation so far for yourself, to carry on from it with the earlier messages gone. Keep what the user wants and any instructions they gave, what has been done and found, decisions made, and where things stand now: open pages, files, logins and anything left to do. Write it as notes, not a reply to the user.`

// Thinking is switched off: a summary needs none and it would only be cut
async function summarizeHistory(messages: ModelMessage[]) {
  const result = await generateText({
    model: getChatModel(),
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

export type ChatUIMessage = UIMessage<
  unknown,
  { compaction: CompactionData },
  InferUITools<SandboxTools>
>

// The chat's first bot, the same one its header shows. Direct chats have only
// one; group chats speak as the first to join until they get their own prompt
async function getChatBot(chatId: string) {
  const member = await db.query.chatMembers.findFirst({
    where: (member, { eq }) => eq(member.chatId, chatId),
    orderBy: (member, { asc }) => [asc(member.joinedAt)],
    with: { bot: true },
  })
  if (!member) {
    throw new Error(`No bot found for chat ${chatId}`)
  }
  return member.bot
}

// One long-lived run per chat. History is kept by the platform's default
// transcript storage, keyed by chatId, and read back by loadChatTranscript
export const chatAgent = chat.withUIMessage<ChatUIMessage>().agent({
  id: "chat",
  uiMessageStreamOptions: {
    // Stream the model's thinking so the chat can show it, collapsed
    sendReasoning: true,
    // Also names tool failures in the chat; the default hides every one
    // behind "An error occurred." Logged in full, shown without the stack
    onError: (error) => {
      console.error("Chat stream error", error)
      const message = error instanceof Error ? error.message : String(error)
      return message.slice(0, 500) || "Something went wrong."
    },
  },
  // Declared here, not only on streamText, so viewScreen's toModelOutput is
  // re-applied when earlier turns are converted back for the model
  tools: async ({ chatId }) => {
    const bot = await getChatBot(chatId)
    return createSandboxTools({ chatId, sandboxId: bot.sandboxId })
  },
  // Messages sent while a reply streams join it at the next step boundary
  // rather than starting a turn of their own
  pendingMessages: {
    shouldInject: () => true,
  },
  // Once the context grows past the threshold, the model gets a summary in
  // place of the earlier turns. The chat still shows them all.
  // Only between turns: mid-turn compaction rebuilds from each step's
  // response.messages, which AI SDK 7 trims to the step's own (see run), and
  // the rebuild in run would undo it anyway
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
  // The default storage rewrites the whole transcript, so a reload shows
  // what these leave too
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
  // next message and continuation runs get the prompt too
  onTurnStart: async ({ chatId }) => {
    chat.prompt.set(buildBotPrompt(await getChatBot(chatId)))
  },
  // streamText comes from the run argument so the managed options apply,
  // including the system prompt set above
  run: async ({ messages, tools, signal, streamText }) => {
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
      // Computer use takes many small steps: think, act, look again
      stopWhen: stepCountIs(60),
      // Rebuilt from every step rather than taken from the argument: the SDK's
      // managed prepareStep (4.7.3) expects each step's response.messages to
      // hold all earlier steps too, as in AI SDK 5/6. AI SDK 7 gives each step
      // only its own, so from the third step on the model would never see
      // another tool result, and would repeat the same call forever
      prepareStep: ({ messages: current, steps }) => {
        // Steps only add assistant and tool messages, so a user message not
        // seen before was injected at this boundary
        const injected = current.filter(
          (message) => message.role === "user" && !known.has(message)
        )
        if (injected.length > 0) {
          injected.forEach((message) => known.add(message))
          steered.set(steps.length - 1, injected)
        }
        return {
          messages: pruneScreenshots([
            ...messages,
            // Arrived before the first step
            ...(steered.get(-1) ?? []),
            ...steps.flatMap((step, i) => [
              ...step.response.messages,
              ...(steered.get(i) ?? []),
            ]),
          ]),
        }
      },
      ...thinkingOptions,
    })
  },
})
