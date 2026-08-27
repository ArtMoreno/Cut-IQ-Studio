import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { DATABASE_FILE } from "../runtimePaths";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

let instance: ReturnType<typeof drizzle<typeof fullSchema>>;

export function getDb() {
  if (!instance) {
    mkdirSync(dirname(DATABASE_FILE), { recursive: true });
    const sqlite = new Database(DATABASE_FILE);
    // WAL keeps the render worker's writes from blocking UI reads, and foreign
    // keys are off by default in SQLite.
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    // A render job can hold a write briefly; wait rather than throwing.
    sqlite.pragma("busy_timeout = 5000");
    instance = drizzle(sqlite, { schema: fullSchema });
  }
  return instance;
}
