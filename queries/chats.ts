import "server-only"

import { auth } from "@clerk/nextjs/server"

import { db } from "@/db"

// The signed-in user's chats, most recent first, each with its bots
export async function getChats() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return []
  }

  const rows = await db.query.chats.findMany({
    where: (chat, { eq }) => eq(chat.userId, userId),
    orderBy: (chat, { desc }) => [desc(chat.lastMessageAt)],
    with: {
      // Direct chats have one bot; group chats list theirs in joining order
      members: {
        orderBy: (member, { asc }) => [asc(member.joinedAt)],
        // Only what the sidebar and search show, since both reach the client
        with: { bot: { columns: { id: true, name: true, avatar: true } } },
      },
    },
  })

  return rows.flatMap(({ members, ...chat }) =>
    members.length > 0
      ? [{ ...chat, bots: members.map((member) => member.bot) }]
      : []
  )
}

export type ChatWithBots = Awaited<ReturnType<typeof getChats>>[number]

// One of the signed-in user's chats with its bots, or null if it doesn't
// exist or belongs to someone else
export async function getChat(chatId: string) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return null
  }

  const row = await db.query.chats.findFirst({
    where: (chat, { and, eq }) =>
      and(eq(chat.id, chatId), eq(chat.userId, userId)),
    with: {
      // Direct chats have one bot; group chats list theirs in joining order
      members: {
        orderBy: (member, { asc }) => [asc(member.joinedAt)],
        with: { bot: true },
      },
    },
  })

  if (!row || row.members.length === 0) {
    return null
  }

  const { members, ...chat } = row
  return { ...chat, bots: members.map((member) => member.bot) }
}

// A chat as its page shows it, with its bots in full so they can be edited
export type ChatWithFullBots = NonNullable<Awaited<ReturnType<typeof getChat>>>

// The signed-in user's bots, oldest first, to pick from for a group chat
export async function getBots() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return []
  }

  return db.query.bots.findMany({
    where: (bot, { eq }) => eq(bot.userId, userId),
    columns: { id: true, name: true, avatar: true },
    orderBy: (bot, { asc }) => [asc(bot.createdAt)],
  })
}
