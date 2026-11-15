import { existsSync, readFileSync } from "node:fs";
import type { AppDefinition } from "@tvn/core";
import type { Kysely } from "kysely";
import { installPagesAccess } from "./access.js";
import { migratePages } from "./db/migrations/index.js";
import { installCollab } from "./collab.js";
import { installLinks, linkRoutes } from "./links.js";
import { installPagesQueryTables } from "./query-tables.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { spaceRoutes } from "./routes/spaces.js";
import { installVersions } from "./routes/versions.js";
import { commentRoutes } from "./routes/comments.js";
import { extraRoutes } from "./routes/extras.js";
import { searchRoutes } from "./routes/search.js";
import { transferRoutes } from "./routes/transfer.js";
import { shareRoutes } from "./routes/shares.js";
import { spaceAdminRoutes } from "./routes/space-admin.js";
import type { PagesDb } from "./db/schema.js";

// The app's package.json: next to dist/ when built (and in the image), two
// levels up from server/src when tests run the sources.
const { version } = JSON.parse(
  readFileSync(
    ["../package.json", "../../package.json"]
      .map((p) => new URL(p, import.meta.url))
      .find((u) => existsSync(u))!,
    "utf8",
  ),
) as { version: string };

/** What makes this app: name, path and routes. Used by the server and by the API client generator. */
export const definition: AppDefinition = {
  name: "nuvenna",
  brand: { productName: "Nuvenna", accent: "#00c2a8" },
  version,
  prefix: "/nuvenna",
  migrate: migratePages,
  routes: (app) => {
    const db = app.database.db as unknown as Kysely<PagesDb>;
    const access = installPagesAccess(app.permissions, db);
    installLinks(app, db);
    installPagesQueryTables(app, db, access);
    return async (scope) => {
      await spaceRoutes(scope, app, db, access);
      const hocuspocus = await installCollab(scope, app, db, access);
      installVersions(scope, app, db, access, hocuspocus);
      await commentRoutes(scope, app, db, access);
      await extraRoutes(scope, app, db, access);
      await searchRoutes(scope, db, access);
      await transferRoutes(scope, db, access);
      await shareRoutes(scope, app, db, access);
      await spaceAdminRoutes(scope, app, db, access);
      await linkRoutes(scope, db, access);
      await knowledgeRoutes(scope, db, access);
    };
  },
};
