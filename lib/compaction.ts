import type { ChatUIMessage } from "@/trigger/chat"

// What /compact leaves of a chat: one message holding the summary. The model
// reads it as the conversation so far, and the chat shows it in its place
export function summaryMessage(id: string, summary: string): ChatUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: `**Conversation summary**\n\n${summary}` }],
  }
}
