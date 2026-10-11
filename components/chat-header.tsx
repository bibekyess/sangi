import { MonitorIcon } from "lucide-react"

import { ChatAvatar } from "@/components/chat-avatar"
import { Button } from "@/components/ui/button"
import type { ChatWithBot } from "@/queries/chats"

export function ChatHeader({ chat }: { chat: ChatWithBot }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <ChatAvatar seed={chat.bot.avatar} className="size-5" />
      <h1 className="truncate text-sm font-medium">
        {chat.name ?? chat.bot.name}
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
