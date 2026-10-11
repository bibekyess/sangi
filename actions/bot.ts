"use server"

import { auth } from "@clerk/nextjs/server"
import { revalidatePath } from "next/cache"

import { db } from "@/db"
import {
  bots,
  chatMembers,
  chats,
  insertBotSchema,
  type Bot,
  type Chat,
  type InsertBot,
} from "@/db/schema"

type CreateBotResult =
  | { success: true; bot: Bot; chat: Chat }
  | { success: false; error: string }

export async function createBot(input: InsertBot): Promise<CreateBotResult> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return { success: false, error: "Sign in to create a bot." }
  }

  // Server Actions are public endpoints, so re-validate what the client sent
  const parsed = insertBotSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message }
  }

  // Every bot starts with its own direct chat; all three rows land or none do
  const { bot, chat } = await db.transaction(async (tx) => {
    const [bot] = await tx
      .insert(bots)
      .values({ ...parsed.data, userId })
      .returning()

    const [chat] = await tx
      .insert(chats)
      .values({ userId, kind: "direct" })
      .returning()

    await tx.insert(chatMembers).values({ chatId: chat.id, botId: bot.id })

    return { bot, chat }
  })

  revalidatePath("/")

  return { success: true, bot, chat }
}
