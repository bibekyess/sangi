import { notFound } from "next/navigation"

import { Chat } from "@/components/chat"
import { ChatHeader } from "@/components/chat-header"
import {
  ComputerPanel,
  ComputerPanelProvider,
} from "@/components/computer-panel"
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { getChat } from "@/queries/chats"

export default async function Page(props: PageProps<"/chats/[chatId]">) {
  const { chatId } = await props.params
  const chat = await getChat(chatId)
  if (!chat) {
    notFound()
  }

  return (
    <ComputerPanelProvider
      key={chat.id}
      botId={chat.bot.id}
      botName={chat.bot.name}
    >
      {/* The group's inline height: 100% beats any class, so size its parent */}
      <div className="h-svh">
        <ResizablePanelGroup orientation="horizontal">
          {/* Panels scroll by default; only the chat's messages should */}
          <ResizablePanel
            id="chat"
            minSize="30%"
            style={{ overflow: "hidden" }}
          >
            <div className="flex h-full flex-col">
              <ChatHeader chat={chat} />
              <Chat key={chat.id} chatId={chat.id} />
            </div>
          </ResizablePanel>
          <ComputerPanel />
        </ResizablePanelGroup>
      </div>
    </ComputerPanelProvider>
  )
}
