import Link from "next/link"
import { UserButton } from "@clerk/nextjs"
import { formatDistanceToNowStrict } from "date-fns"

import { ChatAvatar } from "@/components/chat-avatar"
import { NewChatMenu } from "@/components/new-chat-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { getChats } from "@/queries/bots"

export async function AppSidebar() {
  const chats = await getChats()

  return (
    <Sidebar>
      <SidebarHeader className="flex-row justify-end">
        <NewChatMenu />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Chats</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {chats.map((chat) => (
                <SidebarMenuItem key={chat.id}>
                  <SidebarMenuButton
                    size="lg"
                    render={<Link href={`/chats/${chat.id}`} />}
                  >
                    <ChatAvatar seed={chat.bot.avatar} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate font-medium">
                          {chat.name ?? chat.bot.name}
                        </span>
                        <span className="ms-auto shrink-0 text-xs text-muted-foreground">
                          {formatDistanceToNowStrict(chat.lastMessageAt)}
                        </span>
                      </div>
                      <span className="truncate text-xs text-muted-foreground">
                        {chat.lastMessagePreview}
                      </span>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Clerk renders its own <button>, so the menu button is a div
                shell that mirrors the trigger's focus and open state. Clerk
                mounts into an unstyled div, stretch it so the trigger covers
                the whole menu button. */}
            <SidebarMenuButton
              render={<div />}
              className="p-0 has-focus-visible:ring-2 has-aria-expanded:bg-sidebar-accent has-aria-expanded:text-sidebar-accent-foreground *:data-clerk-component:size-full"
            >
              <UserButton
                showName
                appearance={{
                  elements: {
                    rootBox: "flex size-full",
                    userButtonTrigger:
                      "size-full justify-start rounded-md m-1! text-inherit shadow-none outline-hidden hover:bg-transparent focus:shadow-none",
                    userButtonBox: "w-full min-w-0 justify-start gap-2",
                    userButtonAvatarBox: "order-first size-6 shrink-0",
                    userButtonOuterIdentifier:
                      "truncate ps-0 text-sm font-normal text-inherit",
                  },
                }}
              />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
