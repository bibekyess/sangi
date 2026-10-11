"use client"

import * as React from "react"
import { useChat } from "@ai-sdk/react"
import type { ChatSessionPersistedState } from "@trigger.dev/sdk/chat"
import {
  useLoadTranscript,
  usePendingMessages,
  useTriggerChatTransport,
  type InjectedMessage,
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
  isReasoningPart,
  isToolCallPart,
  ToolSteps,
  type AgentStepPart,
} from "@/components/tool-call"
import { Spinner } from "@/components/ui/spinner"
import type { chatAgent, ChatUIMessage } from "@/trigger/chat"

type ChatTransport = ReturnType<typeof useTriggerChatTransport>

function sessionKey(chatId: string) {
  return `chat-session:${chatId}`
}

// Kept so a reload mid-reply can reconnect to the running turn. Storage can be
// unavailable (private mode, blocked site data), which only loses the resume
function saveSession(
  chatId: string,
  session: ChatSessionPersistedState | null
) {
  try {
    if (session) {
      localStorage.setItem(sessionKey(chatId), JSON.stringify(session))
    } else {
      localStorage.removeItem(sessionKey(chatId))
    }
  } catch {}
}

function readSession(chatId: string): ChatSessionPersistedState | undefined {
  try {
    const saved = localStorage.getItem(sessionKey(chatId))
    return saved ? JSON.parse(saved) : undefined
  } catch {
    return undefined
  }
}

export function Chat({ chatId }: { chatId: string }) {
  const transport = useTriggerChatTransport<typeof chatAgent>({
    task: "chat",
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    startSession: ({ chatId, clientData }) =>
      startChatSession({ chatId, clientData }),
    onSessionChange: saveSession,
  })
  // Restored before the transcript loads. Its saved cursor is dropped so the
  // transcript's takes over: a reply still running started after the history
  // the transcript holds, and resuming from later would cut off its start
  React.useEffect(() => {
    const saved = readSession(chatId)
    if (saved && !transport.getSession(chatId)) {
      transport.setSession(chatId, { ...saved, lastEventId: undefined })
    }
  }, [chatId, transport])
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
  const { messages, sendMessage, setMessages, status, stop } =
    useChat<ChatUIMessage>({
      id: chatId,
      messages: initialMessages,
      transport,
      // Picks up a reply that was still streaming when the page loaded
      resume: true,
    })
  // A message sent mid-reply goes to the running turn, which folds it in at
  // its next step. Sending it through useChat would open a second stream of
  // the same reply
  const pending = usePendingMessages({
    transport,
    chatId,
    status,
    messages,
    setMessages,
    sendMessage,
  })

  function handleSubmit({ text }: PromptInputMessage) {
    if (!text.trim()) {
      return
    }
    pending.steer(text)
  }

  // A steered message also shows inside the reply it joined, so skip it if the
  // transcript keeps a copy of its own
  const injectedIds = new Set(
    messages.flatMap((message) =>
      message.parts.flatMap(pending.getInjectedMessageIds)
    )
  )
  const visibleMessages = messages.filter(
    (message) => !injectedIds.has(message.id)
  )

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
          {visibleMessages.length === 0 ? (
            <ConversationEmptyState
              title="Start a conversation"
              description="Type a message below to begin"
            />
          ) : (
            visibleMessages.flatMap((message) =>
              splitAtInjections(
                message.id,
                groupParts(message.parts, pending.getInjectedMessages)
              ).map((segment) =>
                segment.kind === "injected" ? (
                  <Message from="user" key={segment.key}>
                    <MessageContent>{segment.text}</MessageContent>
                  </Message>
                ) : (
                  <Message from={message.role} key={segment.key}>
                    <MessageContent>
                      {segment.groups.map((group) =>
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
                )
              )
            )
          )}
          {/* Read from the reply rather than message.injected, which only
              catches up a render after the marker arrives */}
          {pending.pending
            .filter((message) => !injectedIds.has(message.id))
            .map((message) => (
              <Message from="user" key={message.id} className="opacity-60">
                <MessageContent>{message.text}</MessageContent>
              </Message>
            ))}
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
            {/* Until the reply starts there is no turn to steer, so wait */}
            <PromptInputSubmit
              status={status}
              onStop={stop}
              disabled={status === "submitted"}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}

type PartGroup =
  | { kind: "text"; key: string; text: string }
  | { kind: "tools"; key: string; parts: AgentStepPart[] }
  | { kind: "injected"; key: string; text: string }

// Consecutive thoughts and tool calls render as one timeline between the text
// around them. Messages the user sent mid-reply mark where the agent took them in
function groupParts(
  parts: ChatUIMessage["parts"],
  getInjectedMessages: (part: unknown) => InjectedMessage[]
) {
  const groups: PartGroup[] = []
  parts.forEach((part, i) => {
    const injected = getInjectedMessages(part)
    if (injected.length > 0) {
      injected.forEach((message) =>
        groups.push({ kind: "injected", key: message.id, text: message.text })
      )
    } else if (part.type === "text") {
      if (part.text.trim()) {
        groups.push({ kind: "text", key: `text-${i}`, text: part.text })
      }
    } else if (isToolCallPart(part) || isReasoningPart(part)) {
      // Empty thoughts have nothing to show once they finish
      if (
        isReasoningPart(part) &&
        !part.text.trim() &&
        part.state !== "streaming"
      ) {
        return
      }
      const last = groups.at(-1)
      if (last?.kind === "tools") {
        last.parts.push(part)
      } else {
        groups.push({ kind: "tools", key: `steps-${i}`, parts: [part] })
      }
    }
  })
  return groups
}

type Segment =
  | { kind: "injected"; key: string; text: string }
  | {
      kind: "reply"
      key: string
      groups: Exclude<PartGroup, { kind: "injected" }>[]
    }

// A reply steered mid-way shows as reply, user message, reply
function splitAtInjections(messageId: string, groups: PartGroup[]) {
  const segments: Segment[] = []
  for (const group of groups) {
    if (group.kind === "injected") {
      segments.push(group)
      continue
    }
    const last = segments.at(-1)
    if (last?.kind === "reply") {
      last.groups.push(group)
    } else {
      segments.push({
        kind: "reply",
        key: `${messageId}-${group.key}`,
        groups: [group],
      })
    }
  }
  return segments
}
