import "server-only"

import { attachDatabasePool } from "@vercel/functions"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import * as schema from "./schema"

// Pooled connection (-pooler host) for app traffic
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// Lets Vercel Fluid compute close idle clients before a function suspends
attachDatabasePool(pool)

export const db = drizzle({ client: pool, schema })
