import { existsSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb } from "./connection";
import { CLIPSIFT_APP_ROOT, CLIPSIFT_INSTALL_ROOT } from "../runtimePaths";

/**
 * Bring the local database up to date on startup.
 *
 * The MariaDB build applied a schema.sql through the database client before the
 * app booted. SQLite has no such step, so the app owns its own migrations and
 * runs them itself — first launch creates the file and every table in it.
 */
export function migrateDatabase(): void {
  const candidates = [
    process.env.CUTIQ_MIGRATIONS_DIR,
    join(CLIPSIFT_APP_ROOT, "db", "migrations"),
    join(CLIPSIFT_INSTALL_ROOT, "resources", "migrations"),
    join(process.cwd(), "db", "migrations"),
  ].filter((path): path is string => Boolean(path));

  const migrationsFolder = candidates.find((path) => existsSync(path));
  if (!migrationsFolder) {
    throw new Error(
      `Cut IQ could not find its database migrations. Looked in: ${candidates.join(", ")}`,
    );
  }

  migrate(getDb(), { migrationsFolder });
}
