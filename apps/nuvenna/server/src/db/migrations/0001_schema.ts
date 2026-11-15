import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { Dialect } from "@tvn/core";

/** All Pages tables. See CONCEPT.md §4 "Pages". */
export function pagesSchema({ types }: Dialect): Migration {
  return {
    async up(db: Kysely<never>) {
      const s = db.schema;
      await s
        .createTable("pages_space")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("space_key", "varchar(20)", (c) => c.notNull().unique())
        .addColumn("name", "varchar(200)", (c) => c.notNull())
        .addColumn("description", types.text, (c) => c.notNull())
        // No foreign key: the home page belongs to the space, which would make a cycle.
        .addColumn("home_page_id", types.id)
        .addColumn("archived", "boolean", (c) => c.notNull())
        .addColumn("created_at", types.timestamp, (c) => c.notNull())
        .execute();
      await s
        .createTable("pages_space_permission")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("space_id", types.id, (c) =>
          c.notNull().references("pages_space.id").onDelete("cascade"),
        )
        .addColumn("permission", "varchar(40)", (c) => c.notNull())
        .addColumn("grantee_type", "varchar(20)", (c) => c.notNull())
        .addColumn("grantee_id", types.id)
        .execute();
      await s
        .createTable("pages_page")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("space_id", types.id, (c) =>
          c.notNull().references("pages_space.id").onDelete("cascade"),
        )
        .addColumn("parent_id", types.id, (c) => c.references("pages_page.id"))
        .addColumn("position", "integer", (c) => c.notNull())
        .addColumn("title", "varchar(500)", (c) => c.notNull())
        .addColumn("kind", "varchar(20)", (c) => c.notNull())
        .addColumn("status", "varchar(20)", (c) => c.notNull())
        .addColumn("version", "integer", (c) => c.notNull())
        .addColumn("content_json", types.text, (c) => c.notNull())
        .addColumn("content_text", types.text, (c) => c.notNull())
        .addColumn("created_by", types.id, (c) =>
          c.notNull().references("core_user.id"),
        )
        .addColumn("created_at", types.timestamp, (c) => c.notNull())
        .addColumn("updated_by", types.id, (c) =>
          c.notNull().references("core_user.id"),
        )
        .addColumn("updated_at", types.timestamp, (c) => c.notNull())
        .addColumn("trashed_at", types.timestamp)
        .execute();
      await s
        .createIndex("idx_pages_page_space_parent")
        .on("pages_page")
        .columns(["space_id", "parent_id"])
        .execute();
      await s
        .createTable("pages_page_ydoc")
        .addColumn("page_id", types.id, (c) =>
          c.primaryKey().references("pages_page.id").onDelete("cascade"),
        )
        .addColumn("state", types.blob, (c) => c.notNull())
        .addColumn("updated_at", types.timestamp, (c) => c.notNull())
        .execute();
      await s
        .createTable("pages_page_version")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("page_id", types.id, (c) =>
          c.notNull().references("pages_page.id").onDelete("cascade"),
        )
        .addColumn("number", "integer", (c) => c.notNull())
        .addColumn("title", "varchar(500)", (c) => c.notNull())
        .addColumn("content_json", types.text, (c) => c.notNull())
        .addColumn("author_id", types.id, (c) =>
          c.notNull().references("core_user.id"),
        )
        .addColumn("message", "varchar(500)")
        .addColumn("created_at", types.timestamp, (c) => c.notNull())
        .addUniqueConstraint("uq_pages_page_version", ["page_id", "number"])
        .execute();
      await s
        .createTable("pages_page_restriction")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("page_id", types.id, (c) =>
          c.notNull().references("pages_page.id").onDelete("cascade"),
        )
        .addColumn("kind", "varchar(10)", (c) => c.notNull())
        .addColumn("grantee_type", "varchar(20)", (c) => c.notNull())
        .addColumn("grantee_id", types.id, (c) => c.notNull())
        .execute();
      await s
        .createTable("pages_page_comment")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("page_id", types.id, (c) =>
          c.notNull().references("pages_page.id").onDelete("cascade"),
        )
        .addColumn("parent_id", types.id, (c) =>
          c.references("pages_page_comment.id").onDelete("cascade"),
        )
        .addColumn("anchor_json", types.text)
        .addColumn("body_json", types.text, (c) => c.notNull())
        .addColumn("body_text", types.text, (c) => c.notNull())
        .addColumn("author_id", types.id, (c) =>
          c.notNull().references("core_user.id"),
        )
        .addColumn("resolved", "boolean", (c) => c.notNull())
        .addColumn("created_at", types.timestamp, (c) => c.notNull())
        .addColumn("updated_at", types.timestamp, (c) => c.notNull())
        .execute();
      await s
        .createTable("pages_page_label")
        .addColumn("page_id", types.id, (c) =>
          c.notNull().references("pages_page.id").onDelete("cascade"),
        )
        .addColumn("label", "varchar(100)", (c) => c.notNull())
        .addPrimaryKeyConstraint("pk_pages_page_label", ["page_id", "label"])
        .execute();
      for (const name of [
        "pages_page_watch",
        "pages_page_favorite",
        "pages_page_like",
      ]) {
        let t = s
          .createTable(name)
          .addColumn("page_id", types.id, (c) =>
            c.notNull().references("pages_page.id").onDelete("cascade"),
          )
          .addColumn("user_id", types.id, (c) =>
            c.notNull().references("core_user.id").onDelete("cascade"),
          )
          .addPrimaryKeyConstraint(`pk_${name}`, ["page_id", "user_id"]);
        if (name !== "pages_page_watch")
          t = t.addColumn("created_at", types.timestamp, (c) => c.notNull());
        await t.execute();
      }
      await s
        .createTable("pages_public_share")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("page_id", types.id, (c) =>
          c.notNull().references("pages_page.id").onDelete("cascade"),
        )
        .addColumn("token_hash", "varchar(100)", (c) => c.notNull().unique())
        .addColumn("expires_at", types.timestamp)
        .addColumn("created_by", types.id, (c) =>
          c.notNull().references("core_user.id"),
        )
        .addColumn("created_at", types.timestamp, (c) => c.notNull())
        .execute();
    },
  };
}
