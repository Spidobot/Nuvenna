// Ticket blocks become rows in core_link (page → issue), so Tickvana can show
// "mentioned on pages". Only keys are stored: Nuvenna never asks Tickvana.
import {
  AppError,
  requireUser,
  type AppContext,
  type CoreDb,
  type RichNode,
  type StoredEvent,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { PagesAccess } from "./access.js";
import type { Kysely } from "kysely";
import type { PagesDb } from "./db/schema.js";

/** Ticket keys in a document, each once. */
export function issueKeys(doc: RichNode): string[] {
  const keys = new Set<string>();
  const walk = (n: RichNode) => {
    if (n.type === "issue" && typeof n.attrs?.key === "string" && n.attrs.key)
      keys.add(n.attrs.key);
    n.content?.forEach(walk);
  };
  walk(doc);
  return [...keys];
}

export function installLinks(app: AppContext, db: Kysely<PagesDb>): void {
  const core = db as unknown as Kysely<CoreDb>;

  app.queue.on(
    "pages-links",
    ["page.created", "page.updated", "page.deleted"],
    async (event: StoredEvent) => {
      const page = await db
        .selectFrom("pages_page")
        .select(["id", "content_json"])
        .where("id", "=", event.entityId)
        .executeTakeFirst();
      if (!page) {
        // Purged, with everything below it (which sends no events of its own).
        await db
          .deleteFrom("core_link")
          .where("from_type", "=", "page")
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("pages_page")
                  .select("pages_page.id")
                  .whereRef("pages_page.id", "=", "core_link.from_id"),
              ),
            ),
          )
          .execute();
        return;
      }
      const keys = issueKeys(JSON.parse(page.content_json));
      await core.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("core_link")
          .where("from_type", "=", "page")
          .where("from_id", "=", page.id)
          .where("to_type", "=", "issue")
          .execute();
        if (keys.length)
          await trx
            .insertInto("core_link")
            .values(
              keys.map((key) => ({
                from_type: "page",
                from_id: page.id,
                to_type: "issue",
                to_id: key,
                kind: "mentions",
                created_at: new Date(),
              })),
            )
            .execute();
      });
    },
  );
}

/** Tickets linked with a page, either way. Only keys; titles come from Tickvana in the browser. */
export async function linkRoutes(
  scope: FastifyInstance,
  db: Kysely<PagesDb>,
  access: PagesAccess,
): Promise<void> {
  const core = db as unknown as Kysely<CoreDb>;
  scope.withTypeProvider<ZodTypeProvider>().get(
    "/pages/:id/issues",
    {
      config: { permission: "custom" as const },
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ keys: z.array(z.string()) }) },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const page = await db
        .selectFrom("pages_page")
        .select(["id", "space_id"])
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (
        !page ||
        !(await access.can(user, "space.view", {
          spaceId: page.space_id,
          pageId: page.id,
        }))
      )
        throw new AppError(404, "not_found", "Not found");
      const [out, back] = await Promise.all([
        core
          .selectFrom("core_link")
          .select("to_id as key")
          .where("from_type", "=", "page")
          .where("from_id", "=", page.id)
          .where("to_type", "=", "issue")
          .execute(),
        core
          .selectFrom("core_link")
          .select("from_id as key")
          .where("from_type", "=", "issue")
          .where("to_type", "=", "page")
          .where("to_id", "=", page.id)
          .execute(),
      ]);
      return { keys: [...new Set([...out, ...back].map((x) => x.key))].sort() };
    },
  );
}
