// Define tables here, then run `npm run db:push`.
// https://orm.drizzle.team/docs/sql-schema-declaration
import { relations, sql } from "drizzle-orm"
import {
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { createInsertSchema } from "drizzle-zod"
import { nanoid } from "nanoid"
import { z } from "zod"

import { AUTO_BOT_NAME } from "@/lib/group-chat"

export const bots = pgTable(
  "bots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => nanoid()),
    // Clerk user ID, e.g. "user_2abc..."
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    // Seed for the bot's generated face
    avatar: text("avatar")
      .notNull()
      .$defaultFn(() => nanoid()),
    // What the bot is for, in a phrase
    job: text("job").notNull(),
    // How it should go about the job
    instructions: text("instructions"),
    // Daytona sandbox ID, created and deleted with the bot
    sandboxId: text("sandbox_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("bots_user_id_idx").on(table.userId),
    // Bots are told apart by name, as in group chats' handoffs, so a user's
    // bots can't share one, whatever the case
    uniqueIndex("bots_user_id_name_idx").on(
      table.userId,
      sql`lower(${table.name})`
    ),
  ]
)

// Fields a user fills in; userId comes from the session, the rest from defaults
export const insertBotSchema = createInsertSchema(bots, {
  name: (schema) =>
    schema
      .trim()
      .min(1, "Give your bot a name.")
      .max(50, "Keep it under 50 characters.")
      // Group chats' coordinator goes by this name
      .refine(
        (name) => name.toLowerCase() !== AUTO_BOT_NAME.toLowerCase(),
        `${AUTO_BOT_NAME} is taken by group chats' coordinator.`
      ),
  avatar: (schema) => schema.min(1),
  job: (schema) =>
    schema
      .trim()
      .min(1, "Give your bot a job.")
      .max(80, "Keep it under 80 characters."),
  instructions: (schema) =>
    schema.trim().max(2000, "Keep it under 2,000 characters."),
}).pick({ name: true, avatar: true, job: true, instructions: true })

export type Bot = typeof bots.$inferSelect
export type NewBot = typeof bots.$inferInsert
export type InsertBot = z.infer<typeof insertBotSchema>

export const chatKind = pgEnum("chat_kind", ["direct", "group"])

export const chats = pgTable(
  "chats",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => nanoid()),
    // Clerk user ID, e.g. "user_2abc..."
    userId: text("user_id").notNull(),
    kind: chatKind("kind").notNull().default("direct"),
    // Null for direct chats, which show the bot's name
    name: text("name"),
    lastMessagePreview: text("last_message_preview"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("chats_user_id_idx").on(table.userId)]
)

export const chatMembers = pgTable(
  "chat_members",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.botId] }),
    index("chat_members_bot_id_idx").on(table.botId),
  ]
)

export const botsRelations = relations(bots, ({ many }) => ({
  memberships: many(chatMembers),
}))

export const chatsRelations = relations(chats, ({ many }) => ({
  members: many(chatMembers),
}))

export const chatMembersRelations = relations(chatMembers, ({ one }) => ({
  chat: one(chats, { fields: [chatMembers.chatId], references: [chats.id] }),
  bot: one(bots, { fields: [chatMembers.botId], references: [bots.id] }),
}))

// A group chat's name and its bots. Members live in their own table, so the
// bot list is added to the chat's fields rather than derived from a column
export const insertGroupChatSchema = createInsertSchema(chats, {
  // Required here, unlike direct chats, which show their bot's name. Replaced
  // rather than refined: drizzle-zod makes a callback's result nullable again
  name: z
    .string()
    .trim()
    .min(1, "Give the group a name.")
    .max(50, "Keep it under 50 characters."),
})
  .pick({ name: true })
  .extend({
    botIds: z
      .array(z.string())
      .min(2, "Pick at least two bots.")
      .refine((ids) => new Set(ids).size === ids.length, "Pick each bot once."),
  })

export type Chat = typeof chats.$inferSelect
export type NewChat = typeof chats.$inferInsert
export type ChatMember = typeof chatMembers.$inferSelect
export type NewChatMember = typeof chatMembers.$inferInsert
export type InsertGroupChat = z.infer<typeof insertGroupChatSchema>

// Screenshots of a bot's sandbox desktop. Too large for the chat stream, so
// tool results carry only the ID and the image is fetched separately
export const screenshots = pgTable(
  "screenshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => nanoid()),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    mediaType: text("media_type").notNull(),
    // Base64-encoded image bytes
    data: text("data").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("screenshots_chat_id_idx").on(table.chatId)]
)

export type Screenshot = typeof screenshots.$inferSelect
