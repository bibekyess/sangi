"use client"

import * as React from "react"
import { UserButton as ClerkUserButton } from "@clerk/nextjs"

function subscribe() {
  return () => {}
}

// Clerk renders nothing on the server and its mount point once clerk-js has
// loaded. When clerk-js loads before this part of the page hydrates, the first
// client render no longer matches the server. Hold the button back until after
// hydration so both start empty.
function UserButton(props: React.ComponentProps<typeof ClerkUserButton>) {
  const isHydrated = React.useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )

  return isHydrated ? <ClerkUserButton {...props} /> : null
}

export { UserButton }
