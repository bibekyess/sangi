"use server"

import { auth } from "@clerk/nextjs/server"
import { and, eq, inArray } from "drizzle-orm"
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

type UpdateBotResult =
  | { success: true; bot: Bot }
  | { success: false; error: string }

export async function updateBot(
  botId: string,
  input: InsertBot
): Promise<UpdateBotResult> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return { success: false, error: "Sign in to edit a bot." }
  }

  const parsed = insertBotSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message }
  }

  // Scope the write to the session's user so one user can't edit another's bot
  const [bot] = await db
    .update(bots)
    .set(parsed.data)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId)))
    .returning()

  if (!bot) {
    return { success: false, error: "That bot doesn't exist." }
  }

  // The bot's name and face show in the sidebar and every chat header
  revalidatePath("/", "layout")

  return { success: true, bot }
}

type DeleteBotResult = { success: true } | { success: false; error: string }

export async function deleteBot(botId: string): Promise<DeleteBotResult> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return { success: false, error: "Sign in to delete a bot." }
  }

  const deleted = await db.transaction(async (tx) => {
    // Direct chats are only the bot's, so they go with it; group chats just
    // lose the membership through the cascade
    const directChatIds = tx
      .select({ id: chatMembers.chatId })
      .from(chatMembers)
      .where(eq(chatMembers.botId, botId))
    await tx
      .delete(chats)
      .where(
        and(
          eq(chats.userId, userId),
          eq(chats.kind, "direct"),
          inArray(chats.id, directChatIds)
        )
      )

    return tx
      .delete(bots)
      .where(and(eq(bots.id, botId), eq(bots.userId, userId)))
      .returning({ id: bots.id })
  })

  if (deleted.length === 0) {
    return { success: false, error: "That bot doesn't exist." }
  }

  revalidatePath("/", "layout")

  return { success: true }
}
