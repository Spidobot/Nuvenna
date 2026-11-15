import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { Dialect } from "@tvn/core";

/** When someone last opened a page, for "recently visited". */
export function pageVisits({ types }: Dialect): Migration {
  return {
    async up(db: Kysely<never>) {
      await db.schema
        .createTable("pages_page_visit")
        .addColumn("page_id", types.id, (c) =>
          c.notNull().references("pages_page.id").onDelete("cascade"),
        )
        .addColumn("user_id", types.id, (c) =>
          c.notNull().references("core_user.id").onDelete("cascade"),
        )
        .addColumn("visited_at", types.timestamp, (c) => c.notNull())
        .addPrimaryKeyConstraint("pk_pages_page_visit", ["page_id", "user_id"])
        .execute();
      await db.schema
        .createIndex("idx_pages_page_visit_user")
        .on("pages_page_visit")
        .columns(["user_id", "visited_at"])
        .execute();
    },
  };
}
