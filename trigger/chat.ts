import { chat } from "@trigger.dev/sdk/ai"

import { db } from "@/db"
import { getChatModel } from "@/lib/ai"
import { buildBotPrompt } from "@/lib/bot-prompt"

// The chat's first bot, the same one its header shows. Direct chats have only
// one; group chats speak as the first to join until they get their own prompt
async function getChatBot(chatId: string) {
  const member = await db.query.chatMembers.findFirst({
    where: (member, { eq }) => eq(member.chatId, chatId),
    orderBy: (member, { asc }) => [asc(member.joinedAt)],
    with: { bot: true },
  })
  return member?.bot ?? null
}

// One long-lived run per chat. History is kept by the platform's default
// transcript storage, keyed by chatId, and read back by loadChatTranscript
export const chatAgent = chat.agent({
  id: "chat",
  // Set every turn rather than once per run, so edits to the bot apply to the
  // next message and continuation runs get the prompt too
  onTurnStart: async ({ chatId }) => {
    const bot = await getChatBot(chatId)
    if (!bot) {
      throw new Error(`No bot found for chat ${chatId}`)
    }
    chat.prompt.set(buildBotPrompt(bot))
  },
  // streamText comes from the run argument so the managed options apply,
  // including the system prompt set above
  run: async ({ messages, signal, streamText }) =>
    streamText({
      model: getChatModel(),
      messages,
      abortSignal: signal,
    }),
})
