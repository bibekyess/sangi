import "server-only"

import { Daytona, DaytonaNotFoundError, type Sandbox } from "@daytona/sdk"

// The SDK refuses to infer an endpoint that a .env file in the working
// directory set, as the Trigger.dev dev worker does, so pass it explicitly
function createDaytona() {
  return new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL || "https://app.daytona.io/api",
  })
}

let client: Daytona | undefined

// Built on first use so a bad config fails the call, not the worker import
function getDaytona() {
  client ??= createDaytona()
  return client
}

// One sandbox per bot, labelled so it can be traced back from the dashboard.
// Without DAYTONA_SNAPSHOT the server picks its default snapshot
export async function createBotSandbox(botId: string, userId: string) {
  const sandbox = await getDaytona().create({
    snapshot: process.env.DAYTONA_SNAPSHOT || undefined,
    labels: { app: "sangi", botId, userId },
  })
  return sandbox.id
}

// Already gone counts as deleted, so a retry after a partial failure succeeds
export async function deleteBotSandbox(sandboxId: string) {
  try {
    const sandbox = await getDaytona().get(sandboxId)
    await getDaytona().delete(sandbox)
  } catch (error) {
    if (error instanceof DaytonaNotFoundError) return
    throw error
  }
}

// Sandboxes stop themselves when idle, so wake this one up if it's asleep
export async function connectBotSandbox(sandboxId: string) {
  const sandbox = await getDaytona().get(sandboxId)
  if (sandbox.state === "starting") {
    await sandbox.waitUntilStarted()
  } else if (sandbox.state !== "started") {
    await sandbox.start()
  }
  return sandbox
}

// The desktop (Xvfb, xfce4, VNC) isn't running until asked for, and doesn't
// survive the sandbox stopping
export async function startDesktop(sandbox: Sandbox) {
  const { status } = await sandbox.computerUse.getStatus()
  if (status === "active") return

  await sandbox.computerUse.start()
  for (let attempt = 0; attempt < 20; attempt++) {
    const { status } = await sandbox.computerUse.getStatus()
    if (status === "active") return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("The desktop didn't start in time.")
}

// noVNC's web client, served by the desktop that startDesktop brings up
const NOVNC_PORT = 6080

// A signed link carries its own token, so the browser can load it in an
// iframe. It's bound to the noVNC port, unlike the sandbox-wide preview token
export async function getDesktopUrl(sandbox: Sandbox) {
  const { url } = await sandbox.getSignedPreviewUrl(NOVNC_PORT, 60 * 60)
  const vnc = new URL("/vnc.html", url)
  vnc.searchParams.set("autoconnect", "true")
  vnc.searchParams.set("resize", "scale")
  return vnc.toString()
}
