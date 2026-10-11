"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { SearchIcon } from "lucide-react"

import { ChatAvatar } from "@/components/chat-avatar"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Kbd } from "@/components/ui/kbd"
import type { ChatWithBot } from "@/queries/bots"

function subscribe() {
  return () => {}
}

// The server cannot know the platform, so it renders the Ctrl label and the
// client swaps in ⌘ on Apple devices after hydration.
function useIsApple() {
  return React.useSyncExternalStore(
    subscribe,
    () => /Mac|iPhone|iPad/.test(navigator.userAgent),
    () => false
  )
}

function ChatSearch({ chats }: { chats: ChatWithBot[] }) {
  const router = useRouter()
  const isApple = useIsApple()
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((open) => !open)
      }
    }

    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <>
      {/* The collapsed sidebar has no room for the search field, so it shows
          an icon button that opens the same dialog. */}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Search chats"
        className="hidden group-data-[collapsible=icon]:inline-flex"
        onClick={() => setOpen(true)}
      >
        <SearchIcon />
      </Button>
      {/* Input's classes, minus file: and placeholder:, so the button looks
          like a search field while keeping the outline button's hover. */}
      <Button
        variant="outline"
        className="h-8 w-full group-data-[collapsible=icon]:hidden min-w-0 justify-start rounded-lg border border-input bg-transparent px-2.5 py-1 text-base font-normal text-muted-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
        onClick={() => setOpen(true)}
      >
        <SearchIcon data-icon="inline-start" />
        Search
        <Kbd className="ms-auto">{isApple ? "⌘K" : "Ctrl K"}</Kbd>
      </Button>
      <CommandDialog
        title="Search chats"
        description="Search for a chat to open"
        open={open}
        onOpenChange={setOpen}
      >
        <Command>
          <CommandInput placeholder="Search chats..." />
          <CommandList>
            <CommandEmpty>No chats found.</CommandEmpty>
            <CommandGroup heading="Chats">
              {chats.map((chat) => {
                const name = chat.name ?? chat.bot.name

                return (
                  <CommandItem
                    key={chat.id}
                    value={chat.id}
                    keywords={[name]}
                    onSelect={() => {
                      setOpen(false)
                      router.push(`/chats/${chat.id}`)
                    }}
                  >
                    <ChatAvatar seed={chat.bot.avatar} className="size-6" />
                    <span className="truncate">{name}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  )
}

export { ChatSearch }
