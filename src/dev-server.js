/**
 * Local development server.
 *
 * This is the Node half of the portability story: it opens a SQLite file and
 * hands the app a driver. The Cloudflare entry point (added in Phase 2) does
 * the same thing with a D1 binding, and the app itself does not change.
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { createApp } from "./app.js";
import { nodeDriver } from "./db.js";

const DB_PATH = process.env.DB_PATH ?? "classroom.db";
const PORT = Number(process.env.PORT ?? 8787);

if (!existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}. Run:  npm run init`);
  process.exit(1);
}

const database = new Database(DB_PATH);
// Write-ahead logging: readers never block the writer, which matters when
// thirty students save answers while the dashboard polls.
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");

const driver = nodeDriver(database);

const app = createApp({
  getDriver: () => driver,
  staticHandler: serveStatic({ root: "./web", rewriteRequestPath: (p) => (p === "/" ? "/test.html" : p) }),
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`\n  Classroom testing platform`);
  console.log(`  Database : ${DB_PATH}`);
  console.log(`  Students : http://localhost:${info.port}/`);
  console.log(`\n  Ctrl+C to stop.\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    database.close();
    process.exit(0);
  });
}
