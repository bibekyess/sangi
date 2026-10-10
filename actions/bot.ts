"use server"

import { auth } from "@clerk/nextjs/server"
import { revalidatePath } from "next/cache"

import { db } from "@/db"
import { bots, insertBotSchema, type Bot, type InsertBot } from "@/db/schema"

type CreateBotResult =
  { success: true; bot: Bot } | { success: false; error: string }

export async function createBot(input: InsertBot): Promise<CreateBotResult> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return { success: false, error: "Sign in to create a bot." }
  }

  // Server Actions are public endpoints, so re-validate what the client sent
  const parsed = insertBotSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message }
  }

  const [bot] = await db
    .insert(bots)
    .values({ ...parsed.data, userId })
    .returning()

  revalidatePath("/")

  return { success: true, bot }
}
