import "server-only"

import { Daytona, DaytonaNotFoundError } from "@daytona/sdk"

// Reads DAYTONA_API_KEY and DAYTONA_API_URL from the environment
const daytona = new Daytona()

// One sandbox per bot, labelled so it can be traced back from the dashboard
export async function createBotSandbox(botId: string, userId: string) {
  const sandbox = await daytona.create({
    labels: { app: "sangi", botId, userId },
  })
  return sandbox.id
}

// Already gone counts as deleted, so a retry after a partial failure succeeds
export async function deleteBotSandbox(sandboxId: string) {
  try {
    const sandbox = await daytona.get(sandboxId)
    await daytona.delete(sandbox)
  } catch (error) {
    if (error instanceof DaytonaNotFoundError) return
    throw error
  }
}
