import "server-only"

import { taskContext } from "@trigger.dev/core/v3"
import type {
  TranscriptLoadOptions,
  TranscriptLoadResult,
  TranscriptScope,
  TranscriptStorage,
} from "@trigger.dev/sdk/ai"
import type { UIMessage } from "ai"
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm"

import { db } from "@/db"
import {
  chatMessages,
  chats,
  type TranscriptCursorsByEnvironment,
  type TriggerEnvironment,
} from "@/db/schema"

const KEY_PREFIXES: [string, TriggerEnvironment][] = [
  ["tr_dev_", "DEVELOPMENT"],
  ["tr_preview_", "PREVIEW"],
  ["tr_stg_", "STAGING"],
  ["tr_prod_", "PRODUCTION"],
]

// The Trigger.dev environment this process talks to: a run's own inside the
// worker, or else the one the app's secret key belongs to
function currentEnvironment(): TriggerEnvironment | undefined {
  const type = taskContext.ctx?.environment.type
  if (type) {
    return type
  }
  const key = process.env.TRIGGER_SECRET_KEY ?? ""
  return KEY_PREFIXES.find(([prefix]) => key.startsWith(prefix))?.[1]
}

// The chat agent's conversations, kept in Neon rather than Trigger.dev's
// storage, so every Trigger.dev environment sees the same history. One row per
// message, so a turn writes its two messages instead of the whole chat
export const transcriptStorage: TranscriptStorage = {
  async load<TUIMessage extends UIMessage>(
    { chatId }: TranscriptScope,
    opts?: TranscriptLoadOptions
  ): Promise<TranscriptLoadResult<TUIMessage>> {
    const chat = await db.query.chats.findFirst({
      where: eq(chats.id, chatId),
      columns: { transcriptState: true, transcriptCursors: true },
    })
    if (!chat) {
      return { messages: [], state: null }
    }

    // A page ends just before the message the previous page started with
    let beforePosition: number | undefined
    if (opts?.before !== undefined) {
      const [before] = await db
        .select({ position: chatMessages.position })
        .from(chatMessages)
        .where(
          and(eq(chatMessages.chatId, chatId), eq(chatMessages.id, opts.before))
        )
      if (!before) {
        return { messages: [], state: chat.transcriptState }
      }
      beforePosition = before.position
    }
    const where = and(
      eq(chatMessages.chatId, chatId),
      beforePosition === undefined
        ? undefined
        : lt(chatMessages.position, beforePosition)
    )

    // The most recent `limit`, plus one to tell whether there are more
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : undefined
    let rows = limit
      ? (
          await db
            .select()
            .from(chatMessages)
            .where(where)
            .orderBy(desc(chatMessages.position))
            .limit(limit + 1)
        ).reverse()
      : await db
          .select()
          .from(chatMessages)
          .where(where)
          .orderBy(asc(chatMessages.position))
    const hasMore = limit !== undefined && rows.length > limit
    if (hasMore) {
      rows = rows.slice(1)
    }

    const environment = currentEnvironment()
    return {
      // Saved by the agent the caller loads for, so in its message type
      messages: rows.map((row) => row.message as TUIMessage),
      state: chat.transcriptState,
      // Another environment's cursors would point into a session stream this
      // one doesn't have, so it starts its own
      cursors: environment ? chat.transcriptCursors[environment] : undefined,
      nextCursor: hasMore ? rows[0].id : undefined,
      nonFinalIds: rows.filter((row) => !row.final).map((row) => row.id),
    }
  },

  async save({ chatId }, { changes, cursors }) {
    await db.transaction(async (tx) => {
      // Locked so two saves to one chat can't hand out the same position. A
      // chat deleted meanwhile has nothing left to save to
      const [chat] = await tx
        .select({ id: chats.id })
        .from(chats)
        .where(eq(chats.id, chatId))
        .for("update")
      if (!chat) {
        return
      }

      const [last] = await tx
        .select({ position: sql<number | null>`max(${chatMessages.position})` })
        .from(chatMessages)
        .where(eq(chatMessages.chatId, chatId))
      let nextPosition = (last?.position ?? -1) + 1

      // Applied in order: a later change can depend on an earlier one
      for (const change of changes) {
        switch (change.op) {
          case "put": {
            const final = change.final ?? true
            // A message already saved keeps its position
            await tx
              .insert(chatMessages)
              .values({
                chatId,
                id: change.message.id,
                position: nextPosition++,
                message: change.message,
                final,
              })
              .onConflictDoUpdate({
                target: [chatMessages.chatId, chatMessages.id],
                set: { message: change.message, final },
              })
            break
          }
          case "remove": {
            await tx
              .delete(chatMessages)
              .where(
                and(
                  eq(chatMessages.chatId, chatId),
                  eq(chatMessages.id, change.id)
                )
              )
            break
          }
          // What an undo or a regenerate becomes
          case "truncateAfter": {
            const [after] = await tx
              .select({ position: chatMessages.position })
              .from(chatMessages)
              .where(
                and(
                  eq(chatMessages.chatId, chatId),
                  eq(chatMessages.id, change.afterId)
                )
              )
            if (after) {
              await tx
                .delete(chatMessages)
                .where(
                  and(
                    eq(chatMessages.chatId, chatId),
                    gt(chatMessages.position, after.position)
                  )
                )
            }
            break
          }
          case "state": {
            await tx
              .update(chats)
              .set({ transcriptState: change.value ?? null })
              .where(eq(chats.id, chatId))
            break
          }
        }
      }

      const environment = currentEnvironment()
      if (cursors && environment) {
        const update: TranscriptCursorsByEnvironment = {
          [environment]: cursors,
        }
        await tx
          .update(chats)
          .set({
            transcriptCursors: sql`${chats.transcriptCursors} || ${JSON.stringify(update)}::jsonb`,
          })
          .where(eq(chats.id, chatId))
      }
    })
  },
}
