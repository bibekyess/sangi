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
    // Also names tool failures in the chat; the default hides every one
    // behind "An error occurred." Logged in full, shown without the stack
    onError: (error) => {
      console.error("Chat stream error", error)
      const message = error instanceof Error ? error.message : String(error)
      return message.slice(0, 500) || "Something went wrong."
    },
  },
  // Declared here, not only on streamText, so screenshots' toModelOutput is
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
      // Computer use takes many small steps: look, act, look again
      stopWhen: stepCountIs(40),
      prepareStep: ({ messages }) => ({ messages: pruneScreenshots(messages) }),
    }),
})
