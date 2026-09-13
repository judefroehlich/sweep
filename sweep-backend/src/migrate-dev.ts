// src/migrate-dev.ts — apply migrations to the DEV database.
//   npm run db:migrate:dev
//
// `npx prisma migrate deploy` reads .env, which is production. That has now
// caught this project twice: once applying a migration to the live database by
// accident, and once creating a table there hours before it was meant to exist.
// Both were additive and harmless, and both were luck rather than judgement —
// the command applies EVERY pending migration, so one destructive file sitting
// unapplied is all it would take.
//
// testEnv.ts already solves this for test scripts. This is the same guard for
// the migrate command: load .env.test over .env, refuse if the target still
// looks like production, and only then hand off to prisma.
import { spawnSync } from "node:child_process";
import { config } from "dotenv";

config({ path: ".env.test" });
config();

/** Hardcoded, for the same reason testEnv.ts hardcodes it. */
const PRODUCTION_REF = "qldyjqrtfuraxvhsslrz";

const target = process.env.DATABASE_URL ?? "";
if (!target) {
  console.error("No DATABASE_URL. Is .env.test missing?");
  process.exit(1);
}
if (target.includes(PRODUCTION_REF)) {
  console.error(
    "Refusing: DATABASE_URL points at the production project.\n" +
      "Set DATABASE_URL in .env.test to the dev project first.\n" +
      "Production migrations run on deploy, from the Dockerfile CMD — never from here.",
  );
  process.exit(1);
}

console.log("Applying migrations to the dev database…");
const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
