"use server"

import { auth } from "@trigger.dev/sdk"
import {
  chat,
  defaultStorage,
  type ChatLoadTranscriptParams,
  type ChatStartSessionParams,
} from "@trigger.dev/sdk/ai"

import type { LoadTranscriptResult } from "@trigger.dev/sdk/chat/react"

import { getChat } from "@/queries/chats"
import type { chatAgent, ChatUIMessage } from "@/trigger/chat"

const startSession = chat.createStartSessionAction<typeof chatAgent>("chat")
const loadTranscript = chat.createLoadTranscriptAction(defaultStorage)

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
  return auth.createPublicToken({
    scopes: { read: { sessions: chatId }, write: { sessions: chatId } },
    expirationTime: "1h",
  })
}

// The chat's saved messages, read from the agent's transcript storage
export async function loadChatTranscript(
  params: ChatLoadTranscriptParams
): Promise<LoadTranscriptResult<ChatUIMessage>> {
  await assertChatOwner(params.chatId)
  const result = await loadTranscript(params)
  // Written by chatAgent, so its parts match the agent's tool set
  return { ...result, messages: result.messages as ChatUIMessage[] }
}
