import { BotDialog } from "@/components/bot-dialog"
import { ChatAvatar } from "@/components/chat-avatar"
import { ComputerPanelToggle } from "@/components/computer-panel"
import { GroupChatAvatar } from "@/components/group-chat-avatar"
import { Button } from "@/components/ui/button"
import type { ChatWithFullBots } from "@/queries/chats"

export function ChatHeader({ chat }: { chat: ChatWithFullBots }) {
  // A group has no one bot to edit or computer to show
  if (chat.kind === "group") {
    return (
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h1 className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <GroupChatAvatar
            seeds={chat.bots.map((bot) => bot.avatar)}
            className="size-5"
          />
          <span className="truncate">{chat.name ?? chat.bots[0].name}</span>
        </h1>
      </header>
    )
  }

  const [bot] = chat.bots

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <h1 className="-ml-2.5 flex min-w-0">
        <BotDialog bot={bot}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title={`Edit ${bot.name}`}
            className="min-w-0 text-sm"
          >
            <ChatAvatar seed={bot.avatar} className="size-5" />
            <span className="truncate">{chat.name ?? bot.name}</span>
          </Button>
        </BotDialog>
      </h1>
      <ComputerPanelToggle />
    </header>
  )
}
