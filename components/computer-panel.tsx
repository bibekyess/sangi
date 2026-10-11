"use client"

import { MonitorIcon, RefreshCwIcon } from "lucide-react"
import { createContext, use, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { getBotDesktopUrl } from "@/actions/bot"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable"
import { Spinner } from "@/components/ui/spinner"
import { Toggle } from "@/components/ui/toggle"
import { cn } from "@/lib/utils"

type Desktop =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; error: string }

const ComputerPanelContext = createContext<{
  title: string
  open: boolean
  setOpen: (open: boolean) => void
  fullscreen: boolean
  setFullscreen: (fullscreen: boolean) => void
  desktop: Desktop
  reload: () => void
  setPanelSlot: (slot: HTMLElement | null) => void
  setDialogSlot: (slot: HTMLElement | null) => void
} | null>(null)

function useComputerPanel() {
  const context = use(ComputerPanelContext)
  if (!context) {
    throw new Error(
      "useComputerPanel must be used within ComputerPanelProvider"
    )
  }
  return context
}

export function ComputerPanelProvider({
  botId,
  botName,
  children,
}: {
  botId: string
  botName: string
  children: React.ReactNode
}) {
  const [open, setOpenState] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [desktop, setDesktop] = useState<Desktop>({ status: "idle" })
  const [panelSlot, setPanelSlot] = useState<HTMLElement | null>(null)
  const [dialogSlot, setDialogSlot] = useState<HTMLElement | null>(null)
  const loading = useRef(false)
  const title = `${botName}'s screen`

  async function load() {
    if (loading.current) return
    loading.current = true
    setDesktop({ status: "loading" })
    const result = await getBotDesktopUrl(botId)
    loading.current = false
    setDesktop(
      result.success
        ? { status: "ready", url: result.url }
        : { status: "error", error: result.error }
    )
  }

  // Wake the sandbox the first time the panel opens, then keep the session
  function setOpen(open: boolean) {
    setOpenState(open)
    if (open && desktop.status === "idle") {
      void load()
    }
  }

  // The fullscreen dialog wins; a closed panel keeps the session alive hidden
  const slot = fullscreen && dialogSlot ? dialogSlot : open ? panelSlot : null

  return (
    <ComputerPanelContext
      value={{
        title,
        open,
        setOpen,
        fullscreen,
        setFullscreen,
        desktop,
        reload: load,
        setPanelSlot,
        setDialogSlot,
      }}
    >
      {children}
      {desktop.status === "ready" &&
        createPortal(
          <DesktopFrame
            url={desktop.url}
            title={title}
            slot={slot}
            interactive={slot !== null && slot === dialogSlot}
          />,
          document.body
        )}
    </ComputerPanelContext>
  )
}

// Moving an iframe in the DOM reloads it and drops the VNC connection, so one
// iframe stays put at the end of the body and is laid over whichever slot is
// showing it: the panel's preview or the fullscreen dialog
function DesktopFrame({
  url,
  title,
  slot,
  interactive,
}: {
  url: string
  title: string
  slot: HTMLElement | null
  interactive: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)

  // Follow the slot every frame so panel resizes and the dialog's open
  // animation don't leave the desktop behind
  useLayoutEffect(() => {
    const frame = ref.current
    if (!frame) return
    if (!slot) {
      frame.style.visibility = "hidden"
      return
    }

    let request = 0
    let last = ""
    const follow = () => {
      const { left, top, width, height } = slot.getBoundingClientRect()
      const next = `${left} ${top} ${width} ${height}`
      if (next !== last) {
        last = next
        Object.assign(frame.style, {
          visibility: "visible",
          left: `${left}px`,
          top: `${top}px`,
          width: `${width}px`,
          height: `${height}px`,
        })
      }
      request = requestAnimationFrame(follow)
    }
    follow()
    return () => cancelAnimationFrame(request)
  }, [slot])

  return (
    <div
      ref={ref}
      className={cn(
        "invisible fixed overflow-hidden rounded-lg",
        // Above the dialog while fullscreen; a click-through preview otherwise
        interactive ? "z-[51]" : "pointer-events-none"
      )}
    >
      <iframe
        src={url}
        title={title}
        tabIndex={interactive ? 0 : -1}
        allow="clipboard-read; clipboard-write"
        className="size-full border-0"
      />
    </div>
  )
}

export function ComputerPanelToggle() {
  const { open, setOpen } = useComputerPanel()
  return (
    <Toggle
      size="sm"
      aria-label="Computer"
      pressed={open}
      onPressedChange={setOpen}
      className="ml-auto"
    >
      <MonitorIcon />
    </Toggle>
  )
}

export function ComputerPanel() {
  const {
    title,
    open,
    fullscreen,
    setFullscreen,
    desktop,
    reload,
    setPanelSlot,
    setDialogSlot,
  } = useComputerPanel()
  if (!open) {
    return null
  }

  return (
    <>
      <ResizableHandle />
      <ResizablePanel
        id="computer"
        defaultSize="40%"
        minSize="20%"
        // Panels scroll by default; this one stays put
        style={{ overflow: "hidden" }}
      >
        <div className="flex h-full flex-col">
          <div className="flex h-12 shrink-0 items-center justify-end px-4">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Reconnect"
              disabled={desktop.status === "loading"}
              onClick={reload}
            >
              <RefreshCwIcon />
            </Button>
          </div>
          <div className="flex flex-col gap-3 px-4">
            <button
              ref={setPanelSlot}
              type="button"
              aria-label={`Open ${title} fullscreen`}
              disabled={desktop.status !== "ready"}
              onClick={() => setFullscreen(true)}
              className="flex aspect-video w-full cursor-zoom-in items-center justify-center rounded-lg border bg-muted text-sm text-muted-foreground disabled:cursor-default"
            >
              {desktop.status === "loading" && <Spinner />}
              {desktop.status === "error" && desktop.error}
            </button>
            <p className="text-center text-sm text-muted-foreground">{title}</p>
          </div>
        </div>
      </ResizablePanel>
      <Dialog
        open={fullscreen}
        // Non-modal, so the desktop laid over the dialog isn't made inert
        modal={false}
        disablePointerDismissal
        // Keys and clicks belong to the desktop, so only the close button
        // closes the dialog: not Escape, outside presses or focus moving away
        onOpenChange={(open, { reason }) => {
          if (open || reason === "close-press") {
            setFullscreen(open)
          }
        }}
      >
        <DialogContent className="h-[calc(100svh-2rem)] grid-rows-[auto_1fr] sm:max-w-[calc(100%-2rem)]">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div ref={setDialogSlot} className="min-h-0 rounded-lg bg-muted" />
        </DialogContent>
      </Dialog>
    </>
  )
}
