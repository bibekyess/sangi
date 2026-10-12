"use client"

import * as React from "react"
import { useChat } from "@ai-sdk/react"
import type { ChatSessionPersistedState } from "@trigger.dev/sdk/chat"
import {
  useChatActions,
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
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { ChatAvatar } from "@/components/chat-avatar"
import {
  isReasoningPart,
  isToolCallPart,
  ToolSteps,
  type AgentStepPart,
} from "@/components/tool-call"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import type { Bot } from "@/db/schema"
import { summaryMessage } from "@/lib/compaction"
import type { chatAgent, ChatUIMessage } from "@/trigger/chat"

type ChatTransport = ReturnType<typeof useTriggerChatTransport>

type ChatBot = Pick<Bot, "id" | "name" | "avatar">

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

// `bots` is passed for group chats, whose messages go to the bot picked in
// the composer. Direct chats leave it out and always reach their one bot
export function Chat({ chatId, bots }: { chatId: string; bots?: ChatBot[] }) {
  const [botId, setBotId] = React.useState(bots?.[0]?.id)
  // A bot removed from the group falls back to the first one left
  const bot = bots?.find((bot) => bot.id === botId) ?? bots?.[0]
  // clientData goes out with every message, so each turn reaches the bot
  // picked when it was sent
  const transport = useTriggerChatTransport<typeof chatAgent>({
    task: "chat",
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    startSession: ({ chatId, clientData }) =>
      startChatSession({ chatId, clientData }),
    onSessionChange: saveSession,
    clientData: { botId: bot?.id },
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
      bots={bots}
      bot={bot}
      onBotChange={setBotId}
    />
  )
}

function ChatView({
  chatId,
  initialMessages,
  transport,
  bots,
  bot,
  onBotChange,
}: {
  chatId: string
  initialMessages: ChatUIMessage[]
  transport: ChatTransport
  bots?: ChatBot[]
  bot?: ChatBot
  onBotChange: (botId: string) => void
}) {
  // Set while the agent summarises the history, after a long reply or for /compact
  const [isCompacting, setIsCompacting] = React.useState(false)
  // Set while /clear or /compact waits on the agent, which isn't a reply
  const [isRunningCommand, setIsRunningCommand] = React.useState(false)
  // Whether the running /compact got its summary back
  const compacted = React.useRef(false)
  const { messages, sendMessage, setMessages, status, stop } =
    useChat<ChatUIMessage>({
      id: chatId,
      messages: initialMessages,
      transport,
      // Picks up a reply that was still streaming when the page loaded
      resume: true,
      onData: (part) => {
        if (part.type !== "data-compaction") {
          return
        }
        if (part.data.status === "compacting") {
          setIsCompacting(true)
          return
        }
        setIsCompacting(false)
        if (part.data.summary) {
          // Applied as it arrives, so a /compact picked up after a reload
          // still replaces the history it summarised
          const { id, text } = part.data.summary
          compacted.current = true
          setMessages([summaryMessage(id, text)])
        } else {
          // The agent compacted on its own; the chat still shows everything
          toast.add({
            title: "Conversation summarized",
            description:
              "The bot now remembers earlier messages as a summary, to keep its answers sharp.",
          })
        }
      },
      // A stream that ends mid-summary never sends "complete"
      onFinish: () => setIsCompacting(false),
      onError: () => setIsCompacting(false),
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

  const { sendAction } = useChatActions({ sendMessage })

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

  function handleSubmit({ text }: PromptInputMessage) {
    if (!text.trim()) {
      return
    }
    const command = text.trim()
    if (command === "/clear" || command === "/compact") {
      void runCommand(command)
      return
    }
    pending.steer(text)
  }

  // Both rewrite the history, which a running reply is still adding to
  async function runCommand(command: "/clear" | "/compact") {
    if (status !== "ready" && status !== "error") {
      toast.add({
        title: `Can't ${command.slice(1)} yet`,
        description: "Wait for the reply to finish, or stop it, first.",
        type: "error",
      })
      return
    }
    if (command === "/compact" && visibleMessages.length === 0) {
      toast.add({ title: "Nothing to summarize yet", type: "info" })
      return
    }
    setIsRunningCommand(true)
    try {
      await (command === "/clear" ? clearHistory() : compactHistory())
    } finally {
      setIsRunningCommand(false)
    }
  }

  // The agent forgets the conversation so far. The server doesn't push history
  // edits back, so the list is emptied here to match
  async function clearHistory() {
    setMessages([])
    await sendAction({ type: "clear" })
  }

  // The agent swaps the conversation for its summary, which then stands in
  // for it here too
  async function compactHistory() {
    compacted.current = false
    setIsCompacting(true)
    await sendAction({ type: "compact" })
    setIsCompacting(false)
    if (!compacted.current) {
      toast.add({
        title: "Couldn't summarize the conversation",
        description: "Nothing was changed. Try again in a moment.",
        type: "error",
      })
    }
  }

  const lastMessage = messages.at(-1)
  // Between sending and the first streamed part there's nothing to show yet
  const isWaiting =
    !isRunningCommand &&
    (status === "submitted" ||
      (status === "streaming" &&
        lastMessage?.role === "assistant" &&
        !lastMessage.parts.some((part) => part.type !== "step-start")))

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
                    {message.role === "assistant" && (
                      <ReplyAuthor
                        bot={bots?.find(
                          (bot) => bot.id === message.metadata?.botId
                        )}
                      />
                    )}
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
          {isCompacting ? (
            <Shimmer className="text-sm" duration={1.5}>
              Summarizing the conversation…
            </Shimmer>
          ) : (
            isWaiting && (
              <Shimmer className="text-sm" duration={1.5}>
                Thinking…
              </Shimmer>
            )
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl p-4 pt-0">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="Send a message, /compact to summarize or /clear to start over..." />
          </PromptInputBody>
          <PromptInputFooter className={bots ? undefined : "justify-end"}>
            {bots && bot && (
              <PromptInputTools>
                {/* A message sent mid-reply joins the running reply, so the
                    bot can only change between replies */}
                <PromptInputSelect
                  value={bot.id}
                  onValueChange={(value) =>
                    typeof value === "string" && onBotChange(value)
                  }
                  disabled={status === "submitted" || status === "streaming"}
                >
                  <PromptInputSelectTrigger aria-label="Bot to talk to">
                    <PromptInputSelectValue>
                      <ChatAvatar seed={bot.avatar} className="size-4" />
                      <span className="truncate">{bot.name}</span>
                    </PromptInputSelectValue>
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent>
                    {bots.map((bot) => (
                      <PromptInputSelectItem key={bot.id} value={bot.id}>
                        <ChatAvatar seed={bot.avatar} className="size-4" />
                        {bot.name}
                      </PromptInputSelectItem>
                    ))}
                  </PromptInputSelectContent>
                </PromptInputSelect>
              </PromptInputTools>
            )}
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

// Which bot wrote a reply in a group chat. Direct chats pass no bots, and
// summaries left by /compact have no author, so neither shows one
function ReplyAuthor({ bot }: { bot?: ChatBot }) {
  if (!bot) {
    return null
  }
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <ChatAvatar seed={bot.avatar} className="size-4" />
      {bot.name}
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
