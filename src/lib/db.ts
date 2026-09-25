import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// Runtime queries go through Supabase's transaction pooler (port 6543).
// Migrations use DIRECT_URL instead - see prisma.config.ts.
//
// connection_limit=1 in the URL is not a typo: each serverless invocation gets
// its own short-lived connection, and letting each one open a pool is how you
// exhaust the pooler under any real traffic.
const connectionString = process.env.DATABASE_URL;

function createClient() {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

// Next dev reloads modules on every edit. Without this the process accumulates
// one connection pool per reload and the pooler starts refusing us.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
