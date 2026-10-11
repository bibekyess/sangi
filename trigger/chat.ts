import { chat, type InferChatUIMessageFromTools } from "@trigger.dev/sdk/ai"
import { stepCountIs } from "ai"

import { db } from "@/db"
import { getChatModel } from "@/lib/ai"
import { buildBotPrompt } from "@/lib/bot-prompt"
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

export type ChatUIMessage = InferChatUIMessageFromTools<SandboxTools>

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
  // Set every turn rather than once per run, so edits to the bot apply to the
  // next message and continuation runs get the prompt too
  onTurnStart: async ({ chatId }) => {
    chat.prompt.set(buildBotPrompt(await getChatBot(chatId)))
  },
  // streamText comes from the run argument so the managed options apply,
  // including the system prompt set above
  run: async ({ messages, tools, signal, streamText }) =>
    streamText({
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
      prepareStep: ({ steps }) => ({
        messages: pruneScreenshots([
          ...messages,
          ...steps.flatMap((step) => step.response.messages),
        ]),
      }),
      ...thinkingOptions,
    }),
})
