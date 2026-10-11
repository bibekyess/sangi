"use client"

import { useChat } from "@ai-sdk/react"
import {
  useLoadTranscript,
  useTriggerChatTransport,
} from "@trigger.dev/sdk/chat/react"

import {
  loadChatTranscript,
  mintChatAccessToken,
  startChatSession,
} from "@/actions/chat"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import { Shimmer } from "@/components/ai-elements/shimmer"
import {
  isToolCallPart,
  ToolSteps,
  type ToolCallPart,
} from "@/components/tool-call"
import { Spinner } from "@/components/ui/spinner"
import type { chatAgent, ChatUIMessage } from "@/trigger/chat"

type ChatTransport = ReturnType<typeof useTriggerChatTransport>

export function Chat({ chatId }: { chatId: string }) {
  const transport = useTriggerChatTransport<typeof chatAgent>({
    task: "chat",
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    startSession: ({ chatId, clientData }) =>
      startChatSession({ chatId, clientData }),
  })
  const { messages, isLoading } = useLoadTranscript<ChatUIMessage>(
    chatId,
    loadChatTranscript,
    { transport }
  )

  // useChat must mount with the saved history already in hand
  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <ChatView
      chatId={chatId}
      initialMessages={messages}
      transport={transport}
    />
  )
}

function ChatView({
  chatId,
  initialMessages,
  transport,
}: {
  chatId: string
  initialMessages: ChatUIMessage[]
  transport: ChatTransport
}) {
  const { messages, sendMessage, status, stop } = useChat<ChatUIMessage>({
    id: chatId,
    messages: initialMessages,
    transport,
  })

  function handleSubmit({ text }: PromptInputMessage) {
    if (!text.trim()) {
      return
    }
    sendMessage({ text })
  }

  const lastMessage = messages.at(-1)
  // Between sending and the first streamed part there's nothing to show yet
  const isWaiting =
    status === "submitted" ||
    (status === "streaming" &&
      lastMessage?.role === "assistant" &&
      !lastMessage.parts.some((part) => part.type !== "step-start"))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="Start a conversation"
              description="Type a message below to begin"
            />
          ) : (
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {groupParts(message.parts).map((group) =>
                    group.kind === "tools" ? (
                      <ToolSteps key={group.key} parts={group.parts} />
                    ) : (
                      <MessageResponse key={group.key}>
                        {group.text}
                      </MessageResponse>
                    )
                  )}
                </MessageContent>
              </Message>
            ))
          )}
          {isWaiting && (
            <Shimmer className="text-sm" duration={1.5}>
              Thinking…
            </Shimmer>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl p-4 pt-0">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="Send a message..." />
          </PromptInputBody>
          <PromptInputFooter className="justify-end">
            <PromptInputSubmit status={status} onStop={stop} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}

type PartGroup =
  | { kind: "text"; key: string; text: string }
  | { kind: "tools"; key: string; parts: ToolCallPart[] }

// Consecutive tool calls render as one timeline between the text around them
function groupParts(parts: ChatUIMessage["parts"]) {
  const groups: PartGroup[] = []
  parts.forEach((part, i) => {
    if (part.type === "text") {
      if (part.text.trim()) {
        groups.push({ kind: "text", key: `text-${i}`, text: part.text })
      }
    } else if (isToolCallPart(part)) {
      const last = groups.at(-1)
      if (last?.kind === "tools") {
        last.parts.push(part)
      } else {
        groups.push({ kind: "tools", key: part.toolCallId, parts: [part] })
      }
    }
  })
  return groups
}
