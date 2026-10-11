"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { SidebarMenuButton } from "@/components/ui/sidebar"

export function ChatMenuButton({
  chatId,
  ...props
}: Omit<
  React.ComponentProps<typeof SidebarMenuButton>,
  "render" | "isActive"
> & {
  chatId: string
}) {
  const href = `/chats/${chatId}`
  const isActive = usePathname() === href

  return (
    <SidebarMenuButton
      isActive={isActive}
      aria-current={isActive ? "page" : undefined}
      render={<Link href={href} />}
      {...props}
    />
  )
}
