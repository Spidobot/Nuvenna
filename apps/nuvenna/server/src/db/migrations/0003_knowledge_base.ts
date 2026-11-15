import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** A space can be offered to customers in the portal as a knowledge base. */
export function knowledgeBase(): Migration {
  return {
    async up(db: Kysely<never>) {
      await db.schema
        .alterTable("pages_space")
        .addColumn("knowledge_base", "boolean", (c) =>
          c.notNull().defaultTo(false),
        )
        .execute();
    },
  };
}
