// Nuvenna' virtual tables for the query engine (CONCEPT.md §3): spaces, pages,
// page_versions, links. Each is cut down to what the asking user may see,
// view restrictions included. Content goes in as plain text, never as JSON.
import type {
  AppContext,
  CatalogColumn,
  CoreDb,
  VirtualTable,
} from "@tvn/core";
import { sql, type Kysely, type SqlBool } from "kysely";
import type { PagesAccess } from "./access.js";
import type { PagesDb } from "./db/schema.js";

const col = (
  name: string,
  type: string,
  description: string,
): CatalogColumn => ({ name, type, description });
const never = sql<SqlBool>`1 = 0`;

export function installPagesQueryTables(
  app: AppContext,
  db: Kysely<PagesDb>,
  access: PagesAccess,
): void {
  /** Ids of the pages this user may see, or null when that is none. */
  async function visible(user: Parameters<PagesAccess["visibleSpaceIds"]>[0]) {
    const spaceIds = await access.visibleSpaceIds(user);
    if (!spaceIds.length) return null;
    return {
      spaceIds,
      hidden: [...(await access.hiddenPageIds(user, spaceIds))],
    };
  }

  const pages: VirtualTable = {
    name: "pages",
    description:
      "Pages, blog posts and templates you may see, not in the trash",
    columns: [
      col("id", "text", "Page id"),
      col("space_id", "text", "Space id"),
      col("space_key", "text", "Key of the space"),
      col("parent_id", "text", "Parent page id"),
      col("title", "text", "Title"),
      col("kind", "text", "page, blog or template"),
      col("text", "text", "Content as plain text"),
      col("version", "number", "Current version number"),
      col("created_by", "text", "User id of the author"),
      col("created_at", "datetime", "When it was created"),
      col("updated_by", "text", "User id of the last editor"),
      col("updated_at", "datetime", "Last change"),
    ],
    reads: [
      {
        table: "pages_page",
        columns: [
          "id",
          "space_id",
          "parent_id",
          "title",
          "kind",
          "status",
          "content_text",
          "version",
          "created_by",
          "created_at",
          "updated_by",
          "updated_at",
        ],
      },
      { table: "pages_space", columns: ["id", "space_key"] },
    ],
    async build({ user }) {
      const v = await visible(user);
      let q = db
        .selectFrom("pages_page as p")
        .innerJoin("pages_space as s", "s.id", "p.space_id")
        .select([
          "p.id",
          "p.space_id",
          "s.space_key",
          "p.parent_id",
          "p.title",
          "p.kind",
          "p.content_text as text",
          "p.version",
          "p.created_by",
          "p.created_at",
          "p.updated_by",
          "p.updated_at",
        ])
        .where("p.status", "=", "current");
      if (!v) return q.where(never);
      q = q.where("p.space_id", "in", v.spaceIds);
      return v.hidden.length ? q.where("p.id", "not in", v.hidden) : q;
    },
  };

  const tables: VirtualTable[] = [
    pages,
    {
      name: "spaces",
      description: "Spaces you may see",
      columns: [
        col("id", "text", "Space id"),
        col("space_key", "text", "Key"),
        col("name", "text", "Name"),
        col("description", "text", "Description"),
        col("home_page_id", "text", "Id of the home page"),
        col("archived", "boolean", "True when archived"),
        col("created_at", "datetime", "When it was created"),
      ],
      reads: [{ table: "pages_space" }],
      async build({ user }) {
        const ids = await access.visibleSpaceIds(user);
        const q = db
          .selectFrom("pages_space")
          .select([
            "id",
            "space_key",
            "name",
            "description",
            "home_page_id",
            "archived",
            "created_at",
          ]);
        return ids.length ? q.where("id", "in", ids) : q.where(never);
      },
    },
    {
      name: "page_versions",
      description: "Saved versions of the pages you may see",
      needs: ["pages"],
      columns: [
        col("id", "text", "Version id"),
        col("page_id", "text", "Page id"),
        col("number", "number", "Version number"),
        col("title", "text", "Title at that version"),
        col("author_id", "text", "User id"),
        col("message", "text", "Note given when saving"),
        col("created_at", "datetime", "When it was saved"),
      ],
      reads: [
        {
          table: "pages_page_version",
          columns: [
            "id",
            "page_id",
            "number",
            "title",
            "author_id",
            "message",
            "created_at",
          ],
        },
      ],
      async build() {
        return db
          .selectFrom("pages_page_version")
          .select([
            "id",
            "page_id",
            "number",
            "title",
            "author_id",
            "message",
            "created_at",
          ])
          .where("page_id", "in", sql<string>`(select id from pages)`);
      },
    },
    {
      name: "links",
      description:
        "Links between pages and tickets: from_type/to_type are page or issue, issues by key",
      needs: ["pages"],
      columns: [
        col("from_type", "text", "page or issue"),
        col("from_id", "text", "Page id or ticket key"),
        col("to_type", "text", "page or issue"),
        col("to_id", "text", "Page id or ticket key"),
        col("kind", "text", "mentions, …"),
        col("created_at", "datetime", "When the link was made"),
      ],
      reads: [{ table: "core_link" }],
      async build() {
        // Only links that touch a page you may see.
        const core = db as unknown as Kysely<CoreDb>;
        return core
          .selectFrom("core_link")
          .select([
            "from_type",
            "from_id",
            "to_type",
            "to_id",
            "kind",
            "created_at",
          ])
          .where((eb) =>
            eb.or([
              eb.and([
                eb("from_type", "=", "page"),
                eb("from_id", "in", sql<string>`(select id from pages)`),
              ]),
              eb.and([
                eb("to_type", "=", "page"),
                eb("to_id", "in", sql<string>`(select id from pages)`),
              ]),
            ]),
          );
      },
    },
  ];
  for (const table of tables) app.query.register(table);
}
