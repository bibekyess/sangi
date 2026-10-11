import { MonitorIcon } from "lucide-react"

import { BotDialog } from "@/components/bot-dialog"
import { ChatAvatar } from "@/components/chat-avatar"
import { Button } from "@/components/ui/button"
import type { ChatWithBot } from "@/queries/chats"

export function ChatHeader({ chat }: { chat: ChatWithBot }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <h1 className="-ml-2.5 flex min-w-0">
        <BotDialog bot={chat.bot}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title={`Edit ${chat.bot.name}`}
            className="min-w-0 text-sm"
          >
            <ChatAvatar seed={chat.bot.avatar} className="size-5" />
            <span className="truncate">{chat.name ?? chat.bot.name}</span>
          </Button>
        </BotDialog>
      </h1>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Computer"
        className="ml-auto text-muted-foreground"
      >
        <MonitorIcon />
      </Button>
    </header>
  )
}
