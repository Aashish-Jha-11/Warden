// Prisma 7 no longer auto-loads .env - the CLI needs it imported here.
// Next.js loads .env on its own, so this affects CLI commands only.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // Migrations only, and they need the DIRECT connection: pgbouncer
    // multiplexes sessions and cannot run DDL.
    //
    // Runtime connections do not come from here at all - src/lib/db.ts opens
    // those through the pg driver adapter against the pooler. Prisma 7 split
    // these two paths and Supabase is exactly the case where that matters.
    url: env("DIRECT_URL"),
  },
});
