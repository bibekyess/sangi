"use server"

import { auth } from "@clerk/nextjs/server"
import { auth as triggerAuth } from "@trigger.dev/sdk"
import {
  chat,
  type ChatLoadTranscriptParams,
  type ChatStartSessionParams,
} from "@trigger.dev/sdk/ai"

import type { LoadTranscriptResult } from "@trigger.dev/sdk/chat/react"
import { and, eq, inArray } from "drizzle-orm"
import { revalidatePath } from "next/cache"

import { db } from "@/db"
import {
  bots,
  chatMembers,
  chats,
  insertGroupChatSchema,
  type Chat,
  type InsertGroupChat,
} from "@/db/schema"
import { transcriptStorage } from "@/lib/transcript-storage"
import { getChat } from "@/queries/chats"
import type { chatAgent, ChatUIMessage } from "@/trigger/chat"

const startSession = chat.createStartSessionAction<typeof chatAgent>("chat")
const loadTranscript = chat.createLoadTranscriptAction(transcriptStorage)

// chatId comes from the browser, so check the signed-in user owns the chat
// before handing out access to its session or transcript
async function assertChatOwner(chatId: string) {
  const owned = await getChat(chatId)
  if (!owned) {
    throw new Error("That chat doesn't exist.")
  }
}

// Creates the chat's session and first run, idempotent per chatId
export async function startChatSession(
  params: ChatStartSessionParams<typeof chatAgent>
) {
  await assertChatOwner(params.chatId)
  return startSession(params)
}

// The transport calls this to refresh an expired session token
export async function mintChatAccessToken(chatId: string) {
  await assertChatOwner(chatId)
  return triggerAuth.createPublicToken({
    scopes: { read: { sessions: chatId }, write: { sessions: chatId } },
    expirationTime: "1h",
  })
}

// The chat's saved messages, read from Neon like the agent reads them
export async function loadChatTranscript(
  params: ChatLoadTranscriptParams
): Promise<LoadTranscriptResult<ChatUIMessage>> {
  await assertChatOwner(params.chatId)
  const result = await loadTranscript(params)
  // Written by chatAgent, so its parts match the agent's tool set
  return { ...result, messages: result.messages as ChatUIMessage[] }
}

type CreateGroupChatResult =
  { success: true; chat: Chat } | { success: false; error: string }

export async function createGroupChat(
  input: InsertGroupChat
): Promise<CreateGroupChatResult> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return { success: false, error: "Sign in to create a group chat." }
  }

  // Server Actions are public endpoints, so re-validate what the client sent
  const parsed = insertGroupChatSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message }
  }
  const { botIds, ...values } = parsed.data

  // Only the user's own bots can join
  const owned = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.userId, userId), inArray(bots.id, botIds)))
  if (owned.length !== botIds.length) {
    return { success: false, error: "One of those bots doesn't exist." }
  }

  const chat = await db.transaction(async (tx) => {
    const [chat] = await tx
      .insert(chats)
      .values({ ...values, userId, kind: "group" })
      .returning()

    // Staggered so the bots keep the order they were picked in, which the
    // chat's avatar and bot picker follow
    const joinedAt = Date.now()
    await tx.insert(chatMembers).values(
      botIds.map((botId, i) => ({
        chatId: chat.id,
        botId,
        joinedAt: new Date(joinedAt + i),
      }))
    )

    return chat
  })

  revalidatePath("/", "layout")

  return { success: true, chat }
}
