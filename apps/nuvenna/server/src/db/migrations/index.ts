import { migrate, type Database } from "@tvn/core";
import type { MigrationResult } from "kysely/migration";
import { pagesSchema } from "./0001_schema.js";
import { pageVisits } from "./0002_visits.js";
import { knowledgeBase } from "./0003_knowledge_base.js";

/** Brings the pages_* tables up to date. Runs after the core migrations. */
export function migratePages<DB>({
  db,
  dialect,
}: Database<DB>): Promise<MigrationResult[]> {
  return migrate(db, "pages", {
    "0001_schema": pagesSchema(dialect),
    "0002_visits": pageVisits(dialect),
    "0003_knowledge_base": knowledgeBase(),
  });
}
