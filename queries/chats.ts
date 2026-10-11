import "server-only"

import { auth } from "@clerk/nextjs/server"

import { db } from "@/db"

// The signed-in user's chats, most recent first, each with its first bot
export async function getChats() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return []
  }

  const rows = await db.query.chats.findMany({
    where: (chat, { eq }) => eq(chat.userId, userId),
    orderBy: (chat, { desc }) => [desc(chat.lastMessageAt)],
    with: {
      // Direct chats have one bot; group chats fall back to the first to join
      members: {
        orderBy: (member, { asc }) => [asc(member.joinedAt)],
        limit: 1,
        with: { bot: true },
      },
    },
  })

  return rows.flatMap(({ members, ...chat }) =>
    members.length > 0 ? [{ ...chat, bot: members[0].bot }] : []
  )
}

export type ChatWithBot = Awaited<ReturnType<typeof getChats>>[number]

// One of the signed-in user's chats with its first bot, or null if it doesn't
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
      members: {
        orderBy: (member, { asc }) => [asc(member.joinedAt)],
        limit: 1,
        with: { bot: true },
      },
    },
  })

  if (!row || row.members.length === 0) {
    return null
  }

  const { members, ...chat } = row
  return { ...chat, bot: members[0].bot }
}
