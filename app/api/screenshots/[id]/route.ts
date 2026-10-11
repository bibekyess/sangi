import { auth } from "@clerk/nextjs/server"
import { and, eq } from "drizzle-orm"

import { db } from "@/db"
import { chats, screenshots } from "@/db/schema"

// A sandbox screenshot, for the signed-in user who owns its chat
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/screenshots/[id]">
) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return new Response("Unauthorized", { status: 401 })
  }

  const { id } = await ctx.params
  const [shot] = await db
    .select({ data: screenshots.data, mediaType: screenshots.mediaType })
    .from(screenshots)
    .innerJoin(chats, eq(chats.id, screenshots.chatId))
    .where(and(eq(screenshots.id, id), eq(chats.userId, userId)))

  if (!shot) {
    return new Response("Not found", { status: 404 })
  }

  return new Response(Buffer.from(shot.data, "base64"), {
    headers: {
      "Content-Type": shot.mediaType,
      // A screenshot never changes once taken
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  })
}
