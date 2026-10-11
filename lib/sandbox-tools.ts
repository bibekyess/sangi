import "server-only"

import type { Sandbox } from "@daytona/sdk"
import { tool, type ModelMessage, type ToolResultPart } from "ai"
import { eq } from "drizzle-orm"
import { posix } from "node:path"
import { z } from "zod"

import { db } from "@/db"
import { screenshots } from "@/db/schema"
import { connectBotSandbox, startDesktop } from "@/lib/daytona"

// Long outputs are cut to keep the model's context small
const MAX_OUTPUT_CHARS = 16_000
const MAX_LISTED_FILES = 500
// Only the latest screenshots are worth showing the model again
const KEPT_SCREENSHOTS = 3
// The desktop's X display; commands need it to open windows on screen
const DESKTOP_ENV = { DISPLAY: ":0" }
// Roughly how long Chromium takes to show a page after launch
const BROWSER_SETTLE_MS = 3000

function truncate(text: string, keep: "head" | "ends" = "head") {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { text, truncated: false }
  }
  if (keep === "head") {
    return { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true }
  }
  // Command output: the start shows what ran, the end shows how it finished
  const half = MAX_OUTPUT_CHARS / 2
  const omitted = text.length - MAX_OUTPUT_CHARS
  return {
    text: `${text.slice(0, half)}\n\n… ${omitted} characters omitted …\n\n${text.slice(-half)}`,
    truncated: true,
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

const coordinates = {
  x: z.number().int().min(0).describe("Pixels from the left edge"),
  y: z.number().int().min(0).describe("Pixels from the top edge"),
}

const screenshotOutput = z.object({
  screenshotId: z.string(),
  width: z.number(),
  height: z.number(),
})

type ScreenshotOutput = z.infer<typeof screenshotOutput>

// The tool result holds only the ID; the image goes to the model from the DB
async function screenshotToModel({
  output,
}: {
  output: ScreenshotOutput
}): Promise<ToolResultPart["output"]> {
  const [shot] = await db
    .select({ data: screenshots.data, mediaType: screenshots.mediaType })
    .from(screenshots)
    .where(eq(screenshots.id, output.screenshotId))

  if (!shot) {
    return { type: "text", value: "This screenshot is no longer available." }
  }

  return {
    type: "content",
    value: [
      {
        type: "text",
        text: `Screenshot of the ${output.width}x${output.height} screen. Coordinates in it match mouse coordinates.`,
      },
      {
        type: "file",
        mediaType: shot.mediaType,
        data: { type: "data", data: shot.data },
      },
    ],
  }
}

// Replace all but the latest screenshots with a note, so long sessions don't
// resend every image on every step
export function pruneScreenshots(messages: ModelMessage[]) {
  let seen = 0
  return messages
    .toReversed()
    .map((message) => {
      if (message.role !== "tool") return message
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== "tool-result" || part.output.type !== "content") {
            return part
          }
          const hasImage = part.output.value.some(
            (item) =>
              item.type === "file" && item.mediaType.startsWith("image/")
          )
          if (!hasImage || ++seen <= KEPT_SCREENSHOTS) return part
          return {
            ...part,
            output: {
              type: "text" as const,
              value:
                "Older screenshot omitted. Take a new one to see the screen.",
            },
          }
        }),
      }
    })
    .toReversed()
}

// Tools that act on one bot's sandbox. Built per turn; the sandbox and its
// desktop are only woken up when a tool first needs them
export function createSandboxTools({
  chatId,
  sandboxId,
}: {
  chatId: string
  sandboxId: string | null
}) {
  let sandbox: Promise<Sandbox> | undefined
  let desktop: Promise<Sandbox> | undefined

  function getSandbox() {
    if (!sandboxId) {
      throw new Error("This bot doesn't have a sandbox.")
    }
    sandbox ??= connectBotSandbox(sandboxId)
    // Let the next call retry instead of reusing a failed connection
    sandbox.catch(() => (sandbox = undefined))
    return sandbox
  }

  function getDesktop() {
    desktop ??= getSandbox().then(async (box) => {
      await startDesktop(box)
      return box
    })
    desktop.catch(() => (desktop = undefined))
    return desktop
  }

  async function takeScreenshot(): Promise<ScreenshotOutput> {
    const box = await getDesktop()
    const [shot, display] = await Promise.all([
      box.computerUse.screenshot.takeCompressed({
        format: "jpeg",
        quality: 70,
        showCursor: true,
      }),
      box.computerUse.display.getInfo(),
    ])
    if (!shot.screenshot) {
      throw new Error("The screenshot came back empty.")
    }

    const screen =
      display.displays?.find((d) => d.isActive) ?? display.displays?.[0]
    const [row] = await db
      .insert(screenshots)
      .values({
        chatId,
        mediaType: "image/jpeg",
        data: shot.screenshot,
        width: screen?.width ?? 0,
        height: screen?.height ?? 0,
      })
      .returning({
        id: screenshots.id,
        width: screenshots.width,
        height: screenshots.height,
      })

    return { screenshotId: row.id, width: row.width, height: row.height }
  }

  return {
    bash: tool({
      description:
        "Run a shell command in the sandbox and return its exit code and combined output. Commands run non-interactively; start long-running or GUI programs in the background.",
      inputSchema: z.object({
        command: z.string().describe("The bash command to run"),
        cwd: z
          .string()
          .optional()
          .describe("Working directory, defaults to /home/daytona"),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe("Give up after this many seconds, default 120"),
      }),
      execute: async ({ command, cwd, timeoutSeconds = 120 }) => {
        const box = await getSandbox()
        const response = await box.process.executeCommand(
          command,
          cwd,
          DESKTOP_ENV,
          timeoutSeconds
        )
        const { text, truncated } = truncate(response.result, "ends")
        return { exitCode: response.exitCode, output: text, truncated }
      },
    }),

    readFile: tool({
      description: "Read a text file from the sandbox.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the file"),
      }),
      execute: async ({ path }) => {
        const box = await getSandbox()
        const buffer = await box.fs.downloadFile(path)
        if (buffer.includes(0)) {
          return {
            path,
            bytes: buffer.length,
            content: "",
            binary: true,
            truncated: false,
          }
        }
        const { text, truncated } = truncate(buffer.toString("utf8"))
        return {
          path,
          bytes: buffer.length,
          content: text,
          binary: false,
          truncated,
        }
      },
    }),

    writeFile: tool({
      description:
        "Write a text file in the sandbox, creating parent folders and replacing any existing file.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the file"),
        content: z.string().describe("The full contents of the file"),
      }),
      execute: async ({ path, content }) => {
        const box = await getSandbox()
        await box.process.executeCommand(
          `mkdir -p ${shellQuote(posix.dirname(path))}`
        )
        const buffer = Buffer.from(content, "utf8")
        await box.fs.uploadFile(buffer, path)
        return { path, bytes: buffer.length }
      },
    }),

    listFiles: tool({
      description: "List the files and folders directly inside a folder.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the folder"),
      }),
      execute: async ({ path }) => {
        const box = await getSandbox()
        const files = await box.fs.listFiles(path)
        const entries = files
          .map((file) => ({
            name: file.name,
            isDir: file.isDir,
            size: file.size,
          }))
          .sort(
            (a, b) =>
              Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)
          )
        return {
          path,
          entries: entries.slice(0, MAX_LISTED_FILES),
          total: entries.length,
        }
      },
    }),

    openBrowser: tool({
      description:
        "Open a web page in Chromium on the desktop. Starts the browser if needed, otherwise opens a new tab. Call viewScreen afterwards to see the page.",
      inputSchema: z.object({
        url: z
          .string()
          .min(1)
          .describe("The address, e.g. https://example.com"),
      }),
      execute: async ({ url }) => {
        const address = /^[a-z][a-z\d+.-]*:/i.test(url) ? url : `https://${url}`
        const box = await getDesktop()
        // Backgrounded so the command returns while the browser keeps running
        await box.process.executeCommand(
          `nohup chromium --no-first-run --no-default-browser-check --start-maximized ${shellQuote(address)} >/tmp/chromium.log 2>&1 &`,
          undefined,
          DESKTOP_ENV,
          30
        )
        await new Promise((resolve) => setTimeout(resolve, BROWSER_SETTLE_MS))
        return { url: address }
      },
    }),

    mouseClick: tool({
      description: "Click the mouse at a point on the screen.",
      inputSchema: z.object({
        ...coordinates,
        button: z.enum(["left", "right", "middle"]).default("left"),
        double: z.boolean().default(false).describe("Double-click"),
      }),
      execute: async ({ x, y, button, double }) => {
        const box = await getDesktop()
        await box.computerUse.mouse.click(x, y, button, double)
        return { x, y }
      },
    }),

    mouseMove: tool({
      description: "Move the mouse pointer to a point on the screen.",
      inputSchema: z.object(coordinates),
      execute: async ({ x, y }) => {
        const box = await getDesktop()
        const position = await box.computerUse.mouse.move(x, y)
        return { x: position.x ?? x, y: position.y ?? y }
      },
    }),

    mouseDrag: tool({
      description:
        "Press the left button at one point, drag to another and release.",
      inputSchema: z.object({
        startX: coordinates.x,
        startY: coordinates.y,
        endX: coordinates.x,
        endY: coordinates.y,
      }),
      execute: async ({ startX, startY, endX, endY }) => {
        const box = await getDesktop()
        await box.computerUse.mouse.drag(startX, startY, endX, endY)
        return { x: endX, y: endY }
      },
    }),

    mouseScroll: tool({
      description: "Scroll the mouse wheel at a point on the screen.",
      inputSchema: z.object({
        ...coordinates,
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(3)
          .describe("Wheel ticks; each moves a few lines"),
      }),
      execute: async ({ x, y, direction, amount }) => {
        const box = await getDesktop()
        await box.computerUse.mouse.scroll(x, y, direction, amount)
        return { x, y }
      },
    }),

    keyboardType: tool({
      description:
        "Type text into the focused window. Newlines press Enter; tabs aren't allowed.",
      inputSchema: z.object({
        text: z.string().min(1),
      }),
      execute: async ({ text }) => {
        const box = await getDesktop()
        await box.computerUse.keyboard.type(text)
        return { characters: text.length }
      },
    }),

    keyboardPress: tool({
      description:
        "Press a key, optionally with modifiers, e.g. key 'enter', or key 'c' with modifiers ['ctrl'].",
      inputSchema: z.object({
        key: z
          .string()
          .min(1)
          .describe(
            "Key name: a letter or digit, enter, escape, tab, backspace, delete, space, up, down, left, right, home, end, pageup, pagedown, f1-f24"
          ),
        modifiers: z.array(z.enum(["ctrl", "alt", "shift", "cmd"])).default([]),
      }),
      execute: async ({ key, modifiers }) => {
        const box = await getDesktop()
        await box.computerUse.keyboard.press(key, modifiers)
        return { key, modifiers }
      },
    }),

    viewScreen: tool({
      description:
        "Take a screenshot so you can see the screen. Only you see it, so use this to check your work between actions.",
      inputSchema: z.object({}),
      outputSchema: screenshotOutput,
      execute: () => takeScreenshot(),
      toModelOutput: screenshotToModel,
    }),

    showScreen: tool({
      description:
        "Take a screenshot and show it to the person in the chat. Use this when they ask to see the screen.",
      inputSchema: z.object({}),
      outputSchema: screenshotOutput,
      execute: () => takeScreenshot(),
      toModelOutput: screenshotToModel,
    }),
  }
}

export type SandboxTools = ReturnType<typeof createSandboxTools>
