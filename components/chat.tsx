"use client"

import * as React from "react"
import { useChat } from "@ai-sdk/react"
import { SparklesIcon } from "lucide-react"
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
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
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
import {
  AUTO_BOT_ID,
  AUTO_BOT_NAME,
  recipientBotId,
  splitLeadingMentions,
} from "@/lib/group-chat"
import { cn } from "@/lib/utils"
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

// `bots` is passed for group chats, whose messages go to the bot they
// @mention, or to Auto, which hands them on. Direct chats leave it out and
// always reach their one bot
export function Chat({ chatId, bots }: { chatId: string; bots?: ChatBot[] }) {
  // The bot last addressed, which a message that @mentions no one goes to
  const [pick, setPick] = React.useState(AUTO_BOT_ID)
  // A bot removed from the group falls back to Auto
  const botId = bots
    ? bots.some((bot) => bot.id === pick)
      ? pick
      : AUTO_BOT_ID
    : undefined
  // clientData goes out with every message, so each turn reaches the bot
  // picked when it was sent
  const transport = useTriggerChatTransport<typeof chatAgent>({
    task: "chat",
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    startSession: ({ chatId, clientData }) =>
      startChatSession({ chatId, clientData }),
    onSessionChange: saveSession,
    clientData: { botId },
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
      botId={botId}
      onBotChange={setPick}
    />
  )
}

function ChatView({
  chatId,
  initialMessages,
  transport,
  bots,
  botId,
  onBotChange,
}: {
  chatId: string
  initialMessages: ChatUIMessage[]
  transport: ChatTransport
  bots?: ChatBot[]
  botId?: string
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
    const command = COMMANDS.find(({ name }) => text.trim() === `/${name}`)
    if (command) {
      void runCommand(command.name)
      return
    }
    if (!bots || !botId) {
      pending.steer(text)
      return
    }
    // In a group chat, the @mentions a message opens with pick who answers,
    // and stay picked. A message without one goes to the bot last addressed,
    // and names it, so the chat and the bots can tell who each was for
    const { botIds, rest } = splitLeadingMentions(text, bots)
    const target = recipientBotId(text, bots, botId)
    const isReplying = status === "submitted" || status === "streaming"
    if (isReplying && target !== botId) {
      toast.add({
        title: "Can't switch bots mid-reply",
        description: "Wait for the reply to finish, or stop it, first.",
        type: "error",
      })
      // A failed submit leaves the message in the composer to send later
      return Promise.reject(new Error("Bot switched mid-reply"))
    }
    // Sent mid-reply, it joins whichever bot is answering, which after a
    // handoff isn't the one addressed, so it isn't named
    if (isReplying) {
      pending.steer(text)
      return
    }
    onBotChange(target)
    // "@Coder" alone only switches who later messages go to
    if (!rest.trim()) {
      return
    }
    const name =
      target === AUTO_BOT_ID
        ? AUTO_BOT_NAME
        : bots.find((bot) => bot.id === target)?.name
    const message = botIds.length > 0 || !name ? text : `@${name} ${text}`
    // The transport's clientData still holds the old pick until the next
    // render, so the pick goes with the message too
    void sendMessage({ text: message }, { metadata: { botId: target } })
  }

  // Both rewrite the history, which a running reply is still adding to
  async function runCommand(command: CommandName) {
    if (status !== "ready" && status !== "error") {
      toast.add({
        title: `Can't ${command} yet`,
        description: "Wait for the reply to finish, or stop it, first.",
        type: "error",
      })
      return
    }
    if (command === "compact" && visibleMessages.length === 0) {
      toast.add({ title: "Nothing to summarize yet", type: "info" })
      return
    }
    setIsRunningCommand(true)
    try {
      await (command === "clear" ? clearHistory() : compactHistory())
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
                    <MessageContent>
                      <AddressedText text={segment.text} bots={bots} />
                    </MessageContent>
                  </Message>
                ) : segment.kind === "handoff" ? (
                  <HandoffReplyMessage
                    key={segment.key}
                    part={segment.part}
                    bots={bots}
                  />
                ) : (
                  <Message from={message.role} key={segment.key}>
                    {message.role === "assistant" && (
                      <ReplyAuthor
                        botId={message.metadata?.botId}
                        bots={bots}
                      />
                    )}
                    <MessageContent>
                      {message.role === "user" ? (
                        <AddressedText
                          text={segment.groups
                            .flatMap((group) =>
                              group.kind === "text" ? [group.text] : []
                            )
                            .join("\n\n")}
                          bots={bots}
                          markdown
                        />
                      ) : (
                        <ReplyGroups groups={segment.groups} />
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
                <MessageContent>
                  <AddressedText text={message.text} bots={bots} />
                </MessageContent>
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
        <PromptInputProvider>
          <Composer
            onSubmit={handleSubmit}
            bots={bots}
            botId={botId}
            status={status}
            stop={stop}
          />
        </PromptInputProvider>
      </div>
    </div>
  )
}

type ComposerProps = {
  onSubmit: (message: PromptInputMessage) => void | Promise<never>
  bots?: ChatBot[]
  botId?: string
  status: ReturnType<typeof useChat>["status"]
  stop: () => void
}

// Where the person writes. Typing / at the start lists the commands, and in a
// group chat typing @ lists the bots to address, both narrowed by what
// follows. A group chat's footer shows who the message goes to
function Composer({ onSubmit, bots, botId, status, stop }: ComposerProps) {
  const { textInput } = usePromptInputController()
  const textarea = React.useRef<HTMLTextAreaElement>(null)
  const listId = React.useId()
  const [caret, setCaret] = React.useState(0)
  const [isFocused, setIsFocused] = React.useState(false)
  const [active, setActive] = React.useState(0)
  // The @ or / whose list Escape closed, so it stays closed until another
  const [dismissedAt, setDismissedAt] = React.useState<number>()

  const query = suggestionQuery(textInput.value, caret, bots)
  const options =
    query && isFocused && query.start !== dismissedAt
      ? suggestions(query, bots)
      : []
  const isOpen = options.length > 0
  const activeIndex = Math.min(active, options.length - 1)
  const optionId = (option: Suggestion) => `${listId}-${option.id}`
  const recipient =
    bots && botId ? recipientBotId(textInput.value, bots, botId) : undefined

  function trackCaret(event: React.SyntheticEvent<HTMLTextAreaElement>) {
    const position = event.currentTarget.selectionStart
    if (position !== caret) {
      setCaret(position)
      setActive(0)
    }
    if (!suggestionQuery(event.currentTarget.value, position, bots)) {
      setDismissedAt(undefined)
    }
  }

  // Completes the / or @ being typed. A command is only filled in, so /clear
  // never runs from a half-typed /cl
  function pick(option: Suggestion) {
    if (!query) {
      return
    }
    const completion =
      option.kind === "command" ? `/${option.name}` : `@${option.name} `
    const value = textInput.value
    textInput.setInput(
      value.slice(0, query.start) + completion + value.slice(caret)
    )
    const position = query.start + completion.length
    setCaret(position)
    // The textarea holds the new text once React has rendered it
    requestAnimationFrame(() => {
      textarea.current?.focus()
      textarea.current?.setSelectionRange(position, position)
    })
  }

  // Runs before the textarea's own handler, which a prevented key skips, so
  // Enter picks from the list rather than sending
  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Shift+Enter still starts a new line
    if (!isOpen || event.nativeEvent.isComposing || event.shiftKey) {
      return
    }
    // A command typed out in full sends as usual, which runs it
    const option = options[activeIndex]
    if (
      event.key === "Enter" &&
      option.kind === "command" &&
      query?.text === option.name
    ) {
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setActive((activeIndex + step + options.length) % options.length)
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault()
      pick(option)
    } else if (event.key === "Escape") {
      event.preventDefault()
      setDismissedAt(query?.start)
    }
  }

  return (
    <div className="relative">
      {isOpen && (
        <div
          id={listId}
          role="listbox"
          aria-label={
            query?.kind === "command" ? "Commands" : "Bots to address"
          }
          className="absolute bottom-full left-0 z-10 mb-2 w-72 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {options.map((option, i) => (
            <div
              key={option.id}
              id={optionId(option)}
              role="option"
              aria-selected={i === activeIndex}
              // Keeps focus in the textarea, which the pick goes back into
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(option)}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                i === activeIndex && "bg-accent text-accent-foreground"
              )}
            >
              {option.kind === "command" ? (
                <>
                  <span className="font-medium">/{option.name}</span>
                  <span className="truncate text-muted-foreground">
                    {option.description}
                  </span>
                </>
              ) : (
                <BotLabel botId={option.id} bots={bots ?? []} />
              )}
            </div>
          ))}
        </div>
      )}
      <PromptInput onSubmit={onSubmit}>
        <PromptInputBody>
          <PromptInputTextarea
            ref={textarea}
            placeholder={
              bots
                ? "Start with @name to choose who answers, or / for commands..."
                : "Send a message, or / for commands..."
            }
            onChange={trackCaret}
            onSelect={trackCaret}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            role="combobox"
            aria-expanded={isOpen}
            aria-controls={isOpen ? listId : undefined}
            aria-activedescendant={
              isOpen ? optionId(options[activeIndex]) : undefined
            }
          />
        </PromptInputBody>
        <PromptInputFooter className={recipient ? undefined : "justify-end"}>
          {bots && recipient && (
            <PromptInputTools className="gap-1.5 px-2 text-xs text-muted-foreground">
              To
              <BotLabel botId={recipient} bots={bots} mention />
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
  )
}

// Typed in place of a message rather than sent to the bot
const COMMANDS = [
  {
    name: "compact",
    description: "Summarize the conversation to keep answers sharp",
  },
  { name: "clear", description: "Start over with an empty conversation" },
] as const

type CommandName = (typeof COMMANDS)[number]["name"]

type SuggestionQuery = { kind: "command" | "bot"; start: number; text: string }

type Suggestion =
  | { kind: "command"; id: string; name: string; description: string }
  | { kind: "bot"; id: string; name: string }

// The / or @ being typed at the caret, and what follows it so far. A command
// is the whole message, so its / comes first with nothing after the caret.
// Only mentions a message opens with pick who answers, so an @ has to come
// before any other text. What follows it can hold spaces, as names can, but a
// space last means the name is done, so "@Code " doesn't offer "@Code
// Reviewer" again
function suggestionQuery(
  text: string,
  caret: number,
  bots?: ChatBot[]
): SuggestionQuery | undefined {
  const before = text.slice(0, caret)
  const command = /^\s*\/([a-z]*)$/i.exec(before)
  if (command && !text.slice(caret).trim()) {
    const start = caret - command[1].length - 1
    return { kind: "command", start, text: command[1] }
  }
  if (!bots) {
    return undefined
  }
  const mention = /(?:^|\s)@([^@\n]*)$/.exec(before)
  if (!mention || /\s$/.test(mention[1])) {
    return undefined
  }
  const start = caret - mention[1].length - 1
  if (splitLeadingMentions(text.slice(0, start), bots).rest.trim()) {
    return undefined
  }
  return { kind: "bot", start, text: mention[1] }
}

// The commands starting with the query, or Auto and the group's bots whose
// names hold it, those starting with it first
function suggestions(query: SuggestionQuery, bots?: ChatBot[]): Suggestion[] {
  const needle = query.text.toLowerCase()
  if (query.kind === "command") {
    return COMMANDS.filter((command) => command.name.startsWith(needle)).map(
      (command) => ({ kind: "command", id: command.name, ...command })
    )
  }
  const options: Suggestion[] = [
    { id: AUTO_BOT_ID, name: AUTO_BOT_NAME },
    ...(bots ?? []),
  ]
    .filter((bot) => bot.name.toLowerCase().includes(needle))
    .map((bot) => ({ kind: "bot", id: bot.id, name: bot.name }))
  return options.sort(
    (a, b) =>
      Number(b.name.toLowerCase().startsWith(needle)) -
      Number(a.name.toLowerCase().startsWith(needle))
  )
}

// What the person wrote, with the bots it opens by addressing shown as chips.
// Saved messages are Markdown; ones still on their way show as typed
function AddressedText({
  text,
  bots,
  markdown = false,
}: {
  text: string
  bots?: ChatBot[]
  markdown?: boolean
}) {
  const { botIds, rest } = bots
    ? splitLeadingMentions(text, bots)
    : { botIds: [], rest: text }
  return (
    <>
      {bots && botIds.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {botIds.map((botId) => (
            <span
              key={botId}
              className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary"
            >
              <BotLabel botId={botId} bots={bots} mention />
            </span>
          ))}
        </div>
      )}
      {rest && (markdown ? <MessageResponse>{rest}</MessageResponse> : rest)}
    </>
  )
}

// A bot, or Auto, with its face, as the composer and replies show it. A
// `mention` reads as @Name, the way a message addresses it
function BotLabel({
  botId,
  bots,
  mention = false,
}: {
  botId: string
  bots: ChatBot[]
  mention?: boolean
}) {
  const at = mention ? "@" : ""
  if (botId === AUTO_BOT_ID) {
    return (
      <>
        <SparklesIcon className="size-4" />
        <span className="truncate">
          {at}
          {AUTO_BOT_NAME}
        </span>
      </>
    )
  }
  const bot = bots.find((bot) => bot.id === botId)
  if (!bot) {
    return null
  }
  return (
    <>
      <ChatAvatar seed={bot.avatar} className="size-4" />
      <span className="truncate">
        {at}
        {bot.name}
      </span>
    </>
  )
}

// Who wrote a reply in a group chat: a bot, or Auto. Direct chats pass no
// bots, and summaries left by /compact have no author, so neither shows one
function ReplyAuthor({ botId, bots }: { botId?: string; bots?: ChatBot[] }) {
  if (!bots || !botId) {
    return null
  }
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <BotLabel botId={botId} bots={bots} />
    </div>
  )
}

type HandoffPart = Extract<
  ChatUIMessage["parts"][number],
  { type: "tool-handoff" }
>

// The bot a message was handed to, answering in a bubble of its own under
// the brief it was given. Its reply streams in as the handoff's output
function HandoffReplyMessage({
  part,
  bots,
}: {
  part: HandoffPart
  bots?: ChatBot[]
}) {
  const reply = part.state === "output-available" ? part.output : undefined
  // The input streams in too, so the name can be missing for a moment
  const name = part.input?.bot
  const botId = reply?.botId ?? bots?.find((bot) => bot.name === name)?.id
  const groups = reply ? replyGroups(reply.message.parts) : []

  return (
    <Message from="assistant">
      <ReplyAuthor botId={botId} bots={bots} />
      {part.input?.brief && (
        <p
          className="line-clamp-2 text-xs text-muted-foreground italic"
          title={part.input.brief}
        >
          {part.input.brief}
        </p>
      )}
      <MessageContent>
        <ReplyGroups groups={groups} />
        {part.state === "output-error" ? (
          <p className="text-sm text-destructive">
            {name ?? "The bot"} couldn&apos;t finish: {part.errorText}
          </p>
        ) : (
          groups.length === 0 && (
            <Shimmer className="text-sm" duration={1.5}>
              {name ? `Handing over to ${name}…` : "Handing over…"}
            </Shimmer>
          )
        )}
      </MessageContent>
    </Message>
  )
}

function ReplyGroups({ groups }: { groups: ReplyGroup[] }) {
  return groups.map((group) =>
    group.kind === "tools" ? (
      <ToolSteps key={group.key} parts={group.parts} />
    ) : (
      <MessageResponse key={group.key}>{group.text}</MessageResponse>
    )
  )
}

type PartGroup =
  | { kind: "text"; key: string; text: string }
  | { kind: "tools"; key: string; parts: AgentStepPart[] }
  | { kind: "injected"; key: string; text: string }
  | { kind: "handoff"; key: string; part: HandoffPart }

type ReplyGroup = Extract<PartGroup, { kind: "text" | "tools" }>

// A handed-off bot's reply, which has no injections or handoffs of its own
function replyGroups(parts: ChatUIMessage["parts"]) {
  return groupParts(parts, () => []).filter(
    (group): group is ReplyGroup =>
      group.kind === "text" || group.kind === "tools"
  )
}

// Consecutive thoughts and tool calls render as one timeline between the text
// around them. Messages the user sent mid-reply mark where the agent took them
// in, and handoffs where another bot answered
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
    } else if (part.type === "tool-handoff") {
      groups.push({ kind: "handoff", key: part.toolCallId, part })
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
  | Extract<PartGroup, { kind: "injected" | "handoff" }>
  | { kind: "reply"; key: string; groups: ReplyGroup[] }

// A reply steered mid-way shows as reply, user message, reply. A handoff
// shows as a reply of its own, from the bot it went to
function splitAtInjections(messageId: string, groups: PartGroup[]) {
  const segments: Segment[] = []
  for (const group of groups) {
    if (group.kind === "injected" || group.kind === "handoff") {
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
