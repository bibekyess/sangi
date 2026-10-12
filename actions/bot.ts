"use server"

import { auth } from "@clerk/nextjs/server"
import { and, eq, inArray, sql } from "drizzle-orm"
import { nanoid } from "nanoid"
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
import {
  connectBotSandbox,
  createBotSandbox,
  deleteBotSandbox,
  getDesktopUrl,
  startDesktop,
} from "@/lib/daytona"

// A failure that belongs to one field, so the form can show it there
type FieldError = { success: false; error: string; field?: "name" }

const nameTaken = {
  success: false,
  error: "You already have a bot with this name.",
  field: "name",
} satisfies FieldError

// Postgres reports a duplicate in a unique index as 23505. Drizzle wraps the
// driver's error, so look at its cause too
function isUniqueViolation(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined
  return [error, cause].some(
    (e) => (e as { code?: string } | undefined)?.code === "23505"
  )
}

type CreateBotResult = { success: true; bot: Bot; chat: Chat } | FieldError

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

  // Checked before the sandbox, which is slow to make. The unique index still
  // catches a name taken in the meantime
  const [sameName] = await db
    .select({ id: bots.id })
    .from(bots)
    .where(
      and(
        eq(bots.userId, userId),
        eq(sql`lower(${bots.name})`, parsed.data.name.toLowerCase())
      )
    )
  if (sameName) {
    return nameTaken
  }

  // Pick the ID up front so the sandbox can be labelled with it
  const botId = nanoid()

  let sandboxId: string
  try {
    sandboxId = await createBotSandbox(botId, userId)
  } catch (error) {
    console.error("Failed to create sandbox", error)
    return { success: false, error: "Couldn't set up your bot. Try again." }
  }

  // Every bot starts with its own direct chat; all three rows land or none do
  let created: { bot: Bot; chat: Chat }
  try {
    created = await db.transaction(async (tx) => {
      const [bot] = await tx
        .insert(bots)
        .values({ ...parsed.data, id: botId, userId, sandboxId })
        .returning()

      const [chat] = await tx
        .insert(chats)
        .values({ userId, kind: "direct" })
        .returning()

      await tx.insert(chatMembers).values({ chatId: chat.id, botId: bot.id })

      return { bot, chat }
    })
  } catch (error) {
    // Don't leave a sandbox behind for a bot that was never saved
    await deleteBotSandbox(sandboxId).catch((cleanupError) =>
      console.error("Failed to delete orphaned sandbox", cleanupError)
    )
    if (isUniqueViolation(error)) {
      return nameTaken
    }
    throw error
  }
  const { bot, chat } = created

  revalidatePath("/")

  return { success: true, bot, chat }
}

type UpdateBotResult = { success: true; bot: Bot } | FieldError

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
  const updated = await db
    .update(bots)
    .set(parsed.data)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId)))
    .returning()
    .catch((error) => {
      if (isUniqueViolation(error)) {
        return null
      }
      throw error
    })
  if (!updated) {
    return nameTaken
  }
  const [bot] = updated

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

  const [existing] = await db
    .select({ sandboxId: bots.sandboxId })
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId)))

  if (!existing) {
    return { success: false, error: "That bot doesn't exist." }
  }

  // Sandbox first: if this fails the bot stays, so the user can retry
  // instead of leaving an orphaned sandbox behind
  if (existing.sandboxId) {
    try {
      await deleteBotSandbox(existing.sandboxId)
    } catch (error) {
      console.error("Failed to delete sandbox", error)
      return { success: false, error: "Couldn't delete your bot. Try again." }
    }
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

type GetBotDesktopUrlResult =
  { success: true; url: string } | { success: false; error: string }

export async function getBotDesktopUrl(
  botId: string
): Promise<GetBotDesktopUrlResult> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return { success: false, error: "Sign in to see your bot's screen." }
  }

  const [bot] = await db
    .select({ sandboxId: bots.sandboxId })
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId)))

  if (!bot?.sandboxId) {
    return { success: false, error: "That bot doesn't have a computer." }
  }

  try {
    const sandbox = await connectBotSandbox(bot.sandboxId)
    await startDesktop(sandbox)
    return { success: true, url: await getDesktopUrl(sandbox) }
  } catch (error) {
    console.error("Failed to open desktop", error)
    return { success: false, error: "Couldn't reach your bot's computer." }
  }
}
