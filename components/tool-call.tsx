"use client"

import {
  ChevronRightIcon,
  EyeIcon,
  FileIcon,
  FilePenIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  GlobeIcon,
  KeyboardIcon,
  MonitorIcon,
  MousePointer2Icon,
  MousePointerClickIcon,
  MoveIcon,
  ScrollTextIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react"
import Image from "next/image"
import type { BundledLanguage } from "shiki"

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block"
import { Shimmer } from "@/components/ai-elements/shimmer"
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalTitle,
} from "@/components/ai-elements/terminal"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { ChatUIMessage } from "@/trigger/chat"

type MessagePart = ChatUIMessage["parts"][number]
export type ToolCallPart = Extract<MessagePart, { type: `tool-${string}` }>

export function isToolCallPart(part: MessagePart): part is ToolCallPart {
  return part.type.startsWith("tool-")
}

type StepStatus = "running" | "done" | "error"

function stepStatus(part: ToolCallPart): StepStatus {
  switch (part.state) {
    case "output-available":
      return "done"
    case "output-error":
    case "output-denied":
      return "error"
    default:
      return "running"
  }
}

// A run of consecutive tool calls, drawn as one timeline like an agent log
export function ToolSteps({ parts }: { parts: ToolCallPart[] }) {
  return (
    <div className="not-prose relative flex flex-col gap-0.5 before:absolute before:top-4 before:bottom-4 before:left-[18px] before:w-px before:bg-border">
      {parts.map((part) => (
        <ToolCall key={part.toolCallId} part={part} />
      ))}
    </div>
  )
}

function ToolCall({ part }: { part: ToolCallPart }) {
  const status = stepStatus(part)
  const error = part.state === "output-error" ? part.errorText : undefined

  switch (part.type) {
    case "tool-bash": {
      const output = part.state === "output-available" ? part.output : null
      return (
        <Step
          icon={SquareTerminalIcon}
          status={status}
          label={status === "running" ? "Running command" : "Ran command"}
          detail={part.input?.command}
          meta={
            output && output.exitCode !== 0 ? `exit ${output.exitCode}` : null
          }
          error={error}
        >
          {part.input?.command && (
            <CommandOutput
              command={part.input.command}
              cwd={part.input.cwd}
              output={output?.output}
              truncated={output?.truncated}
              isRunning={status === "running"}
            />
          )}
        </Step>
      )
    }

    case "tool-readFile": {
      const output = part.state === "output-available" ? part.output : null
      return (
        <Step
          icon={FileTextIcon}
          status={status}
          label={status === "running" ? "Reading" : "Read"}
          detail={part.input?.path}
          meta={output ? formatBytes(output.bytes) : null}
          error={error}
        >
          {output &&
            (output.binary ? (
              <Notice>Binary file, contents not shown.</Notice>
            ) : (
              <FileContents
                path={output.path}
                content={output.content}
                truncated={output.truncated}
              />
            ))}
        </Step>
      )
    }

    case "tool-writeFile":
      return (
        <Step
          icon={FilePenIcon}
          status={status}
          label={status === "running" ? "Writing" : "Wrote"}
          detail={part.input?.path}
          meta={
            part.state === "output-available"
              ? formatBytes(part.output.bytes)
              : null
          }
          error={error}
        >
          {part.input?.path && part.input.content !== undefined && (
            <FileContents path={part.input.path} content={part.input.content} />
          )}
        </Step>
      )

    case "tool-listFiles": {
      const output = part.state === "output-available" ? part.output : null
      return (
        <Step
          icon={FolderOpenIcon}
          status={status}
          label={status === "running" ? "Listing" : "Listed"}
          detail={part.input?.path}
          meta={output ? pluralize(output.total, "item") : null}
          error={error}
        >
          {output && (
            <FileList
              entries={output.entries}
              hidden={output.total - output.entries.length}
            />
          )}
        </Step>
      )
    }

    case "tool-openBrowser":
      return (
        <Step
          icon={GlobeIcon}
          status={status}
          label={status === "running" ? "Opening" : "Opened"}
          detail={part.input?.url}
          error={error}
        />
      )

    case "tool-mouseClick": {
      const { x, y, button, double } = part.input ?? {}
      const kind = double
        ? "Double-clicked"
        : button === "right"
          ? "Right-clicked"
          : button === "middle"
            ? "Middle-clicked"
            : "Clicked"
      return (
        <Step
          icon={MousePointerClickIcon}
          status={status}
          label={status === "running" ? "Clicking" : kind}
          detail={formatPoint(x, y)}
          error={error}
        />
      )
    }

    case "tool-mouseMove":
      return (
        <Step
          icon={MousePointer2Icon}
          status={status}
          label={status === "running" ? "Moving pointer" : "Moved pointer"}
          detail={formatPoint(part.input?.x, part.input?.y)}
          error={error}
        />
      )

    case "tool-mouseDrag": {
      const input = part.input
      const from = formatPoint(input?.startX, input?.startY)
      const to = formatPoint(input?.endX, input?.endY)
      return (
        <Step
          icon={MoveIcon}
          status={status}
          label={status === "running" ? "Dragging" : "Dragged"}
          detail={from && to ? `${from} → ${to}` : undefined}
          error={error}
        />
      )
    }

    case "tool-mouseScroll": {
      const { direction, amount } = part.input ?? {}
      return (
        <Step
          icon={ScrollTextIcon}
          status={status}
          label={status === "running" ? "Scrolling" : "Scrolled"}
          detail={
            direction
              ? `${direction}${amount ? ` × ${amount}` : ""} at ${formatPoint(part.input?.x, part.input?.y)}`
              : undefined
          }
          error={error}
        />
      )
    }

    case "tool-keyboardType":
      return (
        <Step
          icon={KeyboardIcon}
          status={status}
          label={status === "running" ? "Typing" : "Typed"}
          detail={part.input?.text ? `“${part.input.text}”` : undefined}
          error={error}
        />
      )

    case "tool-keyboardPress": {
      const keys = [
        ...(part.input?.modifiers ?? []),
        ...(part.input?.key ? [part.input.key] : []),
      ].filter((key): key is NonNullable<typeof key> => Boolean(key))
      return (
        <Step
          icon={KeyboardIcon}
          status={status}
          label={status === "running" ? "Pressing" : "Pressed"}
          keys={keys}
          error={error}
        />
      )
    }

    // The bot's own look at the screen; the image stays out of the chat
    case "tool-viewScreen":
      return (
        <Step
          icon={EyeIcon}
          status={status}
          label={
            status === "running"
              ? "Looking at the screen"
              : "Looked at the screen"
          }
          error={error}
        />
      )

    case "tool-showScreen":
      return (
        <div>
          <Step
            icon={MonitorIcon}
            status={status}
            label={
              status === "running"
                ? "Capturing the screen"
                : "Captured the screen"
            }
            meta={
              part.state === "output-available"
                ? `${part.output.width}×${part.output.height}`
                : null
            }
            error={error}
          />
          {part.state === "output-available" && (
            <ScreenshotCard {...part.output} />
          )}
        </div>
      )

    // Calls to tools that no longer exist, from older transcripts
    default:
      return null
  }
}

function Step({
  icon: Icon,
  status,
  label,
  detail,
  meta,
  keys,
  error,
  children,
}: {
  icon: LucideIcon
  status: StepStatus
  label: string
  detail?: string
  meta?: string | null
  keys?: string[]
  error?: string
  children?: React.ReactNode
}) {
  const body = (
    <>
      <span
        className={cn(
          "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background",
          status === "error" && "border-destructive/40 text-destructive"
        )}
      >
        {status === "running" ? (
          <Spinner className="size-3.5" />
        ) : status === "error" ? (
          <TriangleAlertIcon className="size-3.5" />
        ) : (
          <Icon className="size-3.5" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {status === "running" ? (
          <Shimmer as="span" className="shrink-0 text-sm" duration={1.5}>
            {label}
          </Shimmer>
        ) : (
          <span className="shrink-0 text-sm text-muted-foreground">
            {label}
          </span>
        )}
        {detail && (
          <span className="truncate font-mono text-xs text-foreground/80">
            {detail}
          </span>
        )}
        {keys && keys.length > 0 && (
          <KbdGroup>
            {keys.map((key, i) => (
              <Kbd key={`${key}-${i}`} className="capitalize">
                {key}
              </Kbd>
            ))}
          </KbdGroup>
        )}
      </span>
      {status === "error" ? (
        <span className="shrink-0 text-xs font-medium text-destructive">
          Failed
        </span>
      ) : (
        meta && (
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            {meta}
          </span>
        )
      )}
    </>
  )

  const content = (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      {children}
    </>
  )
  const expandable = Boolean(error || children)

  if (!expandable) {
    return <div className="flex h-8 items-center gap-2.5 px-1.5">{body}</div>
  }

  return (
    <Collapsible defaultOpen={Boolean(error)}>
      <CollapsibleTrigger className="group flex h-8 w-full items-center gap-2.5 rounded-md px-1.5 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50">
        {body}
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0">
        <div className="flex flex-col gap-2 pt-1 pb-2 pl-10">{content}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function CommandOutput({
  command,
  cwd,
  output,
  truncated,
  isRunning,
}: {
  command: string
  cwd?: string
  output?: string
  truncated?: boolean
  isRunning: boolean
}) {
  const text = output ?? ""
  return (
    <Terminal output={text} isStreaming={isRunning}>
      <TerminalHeader className="py-1.5 pr-1.5 pl-3">
        <TerminalTitle className="min-w-0 text-xs">
          <span className="truncate font-mono">{cwd ?? "~"}</span>
        </TerminalTitle>
        <TerminalActions>
          <TerminalCopyButton />
        </TerminalActions>
      </TerminalHeader>
      <TerminalContent className="max-h-80 p-3 text-xs">
        <pre className="font-mono wrap-break-word whitespace-pre-wrap">
          <span className="text-emerald-400">$ </span>
          <span className="text-zinc-100">{command}</span>
          {"\n"}
          <span className="text-zinc-300">{text}</span>
          {isRunning && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-zinc-100 align-middle" />
          )}
          {!isRunning && !text && (
            <span className="text-zinc-500">(no output)</span>
          )}
        </pre>
      </TerminalContent>
      {truncated && (
        <div className="border-t border-zinc-800 px-3 py-1.5 text-xs text-zinc-500">
          Output shortened
        </div>
      )}
    </Terminal>
  )
}

function FileContents({
  path,
  content,
  truncated,
}: {
  path: string
  content: string
  truncated?: boolean
}) {
  return (
    <CodeBlock
      code={content}
      language={languageFor(path)}
      showLineNumbers
      className="[&_pre]:max-h-80 [&_pre]:text-xs"
    >
      <CodeBlockHeader className="py-1.5 pr-1.5">
        <CodeBlockTitle className="min-w-0">
          <FileIcon className="size-3.5 shrink-0" />
          <CodeBlockFilename className="truncate">{path}</CodeBlockFilename>
          {truncated && <span className="shrink-0">· shortened</span>}
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton className="size-7" />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  )
}

function FileList({
  entries,
  hidden,
}: {
  entries: { name: string; isDir: boolean; size: number }[]
  hidden: number
}) {
  if (entries.length === 0) {
    return <Notice>Empty folder</Notice>
  }
  return (
    <div className="max-h-72 overflow-auto rounded-md border bg-muted/30 py-1">
      {entries.map((entry) => (
        <div
          key={entry.name}
          className="flex items-center gap-2 px-3 py-1 font-mono text-xs"
        >
          {entry.isDir ? (
            <FolderIcon className="size-3.5 shrink-0 text-sky-500" />
          ) : (
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="flex-1 truncate">
            {entry.name}
            {entry.isDir && "/"}
          </span>
          {!entry.isDir && (
            <span className="text-muted-foreground tabular-nums">
              {formatBytes(entry.size)}
            </span>
          )}
        </div>
      ))}
      {hidden > 0 && (
        <div className="px-3 py-1 text-xs text-muted-foreground">
          and {pluralize(hidden, "more item")}
        </div>
      )}
    </div>
  )
}

function ScreenshotCard({
  screenshotId,
  width,
  height,
}: {
  screenshotId: string
  width: number
  height: number
}) {
  const src = `/api/screenshots/${screenshotId}`
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="mt-1 mb-2 ml-10 block overflow-hidden rounded-lg border bg-muted shadow-sm transition-shadow hover:shadow-md"
    >
      <Image
        src={src}
        alt="Screenshot of the sandbox screen"
        width={width || 1024}
        height={height || 768}
        unoptimized
        className="h-auto w-full"
      />
    </a>
  )
}

function Notice({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "error"
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 font-mono text-xs wrap-break-word whitespace-pre-wrap",
        tone === "error"
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "bg-muted/30 text-muted-foreground"
      )}
    >
      {children}
    </div>
  )
}

function formatPoint(x?: number, y?: number) {
  return x === undefined || y === undefined ? undefined : `(${x}, ${y})`
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function pluralize(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  cjs: "javascript",
  js: "javascript",
  mjs: "javascript",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  ts: "typescript",
  yml: "yaml",
}

// Unknown languages fall back to plain text inside CodeBlock
function languageFor(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? ""
  return (LANGUAGE_BY_EXTENSION[extension] ?? extension) as BundledLanguage
}
