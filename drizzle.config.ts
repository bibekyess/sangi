import { loadEnvConfig } from "@next/env"
import { defineConfig } from "drizzle-kit"

loadEnvConfig(process.cwd())

if (!process.env.DATABASE_URL_UNPOOLED) {
  throw new Error("DATABASE_URL_UNPOOLED is not set. Run `neon env pull`.")
}

export default defineConfig({
  schema: "./db/schema.ts",
  dialect: "postgresql",
  // Schema push needs a direct (non-pooled) connection
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED },
})
