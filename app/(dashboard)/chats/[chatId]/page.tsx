import { notFound } from "next/navigation"

import { ChatHeader } from "@/components/chat-header"
import { getChat } from "@/queries/chats"

export default async function Page(props: PageProps<"/chats/[chatId]">) {
  const { chatId } = await props.params
  const chat = await getChat(chatId)
  if (!chat) {
    notFound()
  }

  return (
    <div className="flex min-h-svh flex-col">
      <ChatHeader chat={chat} />
    </div>
  )
}
