// Around a page: labels, watching, favourites, likes, recently visited,
// blog posts, and the notifications for watchers and mentioned people.
import {
  AppError,
  requireUser,
  type AppContext,
  type AuthUser,
  type CoreDb,
  type StoredEvent,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { PagesAccess } from "../access.js";
import type { PagesDb } from "../db/schema.js";

type Page = PagesDb["pages_page"];
/** Edits within this time after the last one do not notify again. */
const EDIT_QUIET_MS = 30 * 60_000;

const TEXT = {
  de: {
    someone: "Jemand",
    updated: (who: string) => `${who} hat die Seite geändert`,
    created: (who: string) => `${who} hat eine Unterseite angelegt`,
    commented: (who: string) => `${who} hat kommentiert`,
    mentioned: (who: string) => `${who} hat dich erwähnt`,
  },
  en: {
    someone: "Someone",
    updated: (who: string) => `${who} changed the page`,
    created: (who: string) => `${who} added a sub-page`,
    commented: (who: string) => `${who} commented`,
    mentioned: (who: string) => `${who} mentioned you`,
  },
};

export async function extraRoutes(
  scope: FastifyInstance,
  app: AppContext,
  db: Kysely<PagesDb>,
  access: PagesAccess,
): Promise<void> {
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const custom = { permission: "custom" as const };
  const core = db as unknown as Kysely<CoreDb>;
  const idParam = z.object({ id: z.string() });

  const sees = (user: AuthUser | null, p: Pick<Page, "id" | "space_id">) =>
    access.can(user, "space.view", { spaceId: p.space_id, pageId: p.id });
  async function loadPage(user: AuthUser | null, id: string) {
    const page = await db
      .selectFrom("pages_page")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!page || !(await sees(user, page)))
      throw new AppError(404, "not_found", "Not found");
    return page;
  }
  /** Of these pages, the ones the user may see, with their space keys. */
  async function visible(user: AuthUser, pages: Page[]) {
    const keys = new Map(
      (
        await db.selectFrom("pages_space").select(["id", "space_key"]).execute()
      ).map((s) => [s.id, s.space_key]),
    );
    const out: {
      id: string;
      spaceKey: string;
      title: string;
      kind: string;
      updatedAt: string;
    }[] = [];
    for (const p of pages)
      if (p.status === "current" && (await sees(user, p)))
        out.push({
          id: p.id,
          spaceKey: keys.get(p.space_id)!,
          title: p.title,
          kind: p.kind,
          updatedAt: p.updated_at.toISOString(),
        });
    return out;
  }
  const listOut = z.array(
    z.object({
      id: z.string(),
      spaceKey: z.string(),
      title: z.string(),
      kind: z.string(),
      updatedAt: z.string(),
    }),
  );

  // --- Meta of one page ---------------------------------------------------------------

  r.get(
    "/pages/:id/meta",
    {
      config: custom,
      schema: {
        params: idParam,
        response: {
          200: z.object({
            labels: z.array(z.string()),
            watching: z.boolean(),
            favorite: z.boolean(),
            liked: z.boolean(),
            likes: z.number(),
          }),
        },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const page = await loadPage(user, req.params.id);
      const has = (
        table: "pages_page_watch" | "pages_page_favorite" | "pages_page_like",
      ) =>
        db
          .selectFrom(table)
          .select("page_id")
          .where("page_id", "=", page.id)
          .where("user_id", "=", user.id)
          .executeTakeFirst();
      const [labels, watching, favorite, liked, likes] = await Promise.all([
        db
          .selectFrom("pages_page_label")
          .select("label")
          .where("page_id", "=", page.id)
          .orderBy("label")
          .execute(),
        has("pages_page_watch"),
        has("pages_page_favorite"),
        has("pages_page_like"),
        db
          .selectFrom("pages_page_like")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("page_id", "=", page.id)
          .executeTakeFirstOrThrow(),
      ]);
      return {
        labels: labels.map((l) => l.label),
        watching: !!watching,
        favorite: !!favorite,
        liked: !!liked,
        likes: Number(likes.n),
      };
    },
  );

  r.put(
    "/pages/:id/labels",
    {
      config: custom,
      schema: {
        params: idParam,
        body: z.object({
          labels: z
            .array(
              z
                .string()
                .trim()
                .toLowerCase()
                .regex(/^[\p{L}\p{N}_-]{1,100}$/u),
            )
            .max(50),
        }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const page = await loadPage(user, req.params.id);
      await access.require(user, "space.edit", {
        spaceId: page.space_id,
        pageId: page.id,
      });
      const labels = [...new Set(req.body.labels)];
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("pages_page_label")
          .where("page_id", "=", page.id)
          .execute();
        if (labels.length)
          await trx
            .insertInto("pages_page_label")
            .values(labels.map((label) => ({ page_id: page.id, label })))
            .execute();
      });
      return reply.status(204).send(null);
    },
  );

  r.get(
    "/labels/:label",
    {
      config: { permission: "authenticated" as const },
      schema: {
        params: z.object({ label: z.string().max(100) }),
        response: { 200: listOut },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const pages = await db
        .selectFrom("pages_page as p")
        .innerJoin("pages_page_label as l", "l.page_id", "p.id")
        .selectAll("p")
        .where("l.label", "=", req.params.label.toLowerCase())
        .orderBy("p.title")
        .limit(500)
        .execute();
      return visible(user, pages);
    },
  );

  // --- Watching, favourites, likes ----------------------------------------------------

  for (const [path, table] of [
    ["watch", "pages_page_watch"],
    ["favorite", "pages_page_favorite"],
    ["like", "pages_page_like"],
  ] as const) {
    r.put(
      `/pages/:id/${path}`,
      {
        config: custom,
        schema: { params: idParam, response: { 204: z.null() } },
      },
      async (req, reply) => {
        const user = requireUser(req);
        const page = await loadPage(user, req.params.id);
        const known = await db
          .selectFrom(table)
          .select("page_id")
          .where("page_id", "=", page.id)
          .where("user_id", "=", user.id)
          .executeTakeFirst();
        if (!known)
          await (
            db.insertInto(table) as ReturnType<
              typeof db.insertInto<"pages_page_like">
            >
          )
            .values(
              (table === "pages_page_watch"
                ? { page_id: page.id, user_id: user.id }
                : {
                    page_id: page.id,
                    user_id: user.id,
                    created_at: new Date(),
                  }) as never,
            )
            .execute();
        return reply.status(204).send(null);
      },
    );
    r.delete(
      `/pages/:id/${path}`,
      {
        config: custom,
        schema: { params: idParam, response: { 204: z.null() } },
      },
      async (req, reply) => {
        const user = requireUser(req);
        await db
          .deleteFrom(table)
          .where("page_id", "=", req.params.id)
          .where("user_id", "=", user.id)
          .execute();
        return reply.status(204).send(null);
      },
    );
  }

  r.get(
    "/me/favorites",
    {
      config: { permission: "authenticated" as const },
      schema: { response: { 200: listOut } },
    },
    async (req) => {
      const user = requireUser(req);
      const pages = await db
        .selectFrom("pages_page as p")
        .innerJoin("pages_page_favorite as f", "f.page_id", "p.id")
        .selectAll("p")
        .where("f.user_id", "=", user.id)
        .orderBy("f.created_at", "desc")
        .execute();
      return visible(user, pages);
    },
  );

  // --- Recently visited ---------------------------------------------------------------

  r.post(
    "/pages/:id/visit",
    {
      config: custom,
      schema: { params: idParam, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const page = await loadPage(user, req.params.id);
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("pages_page_visit")
          .where("page_id", "=", page.id)
          .where("user_id", "=", user.id)
          .execute();
        await trx
          .insertInto("pages_page_visit")
          .values({
            page_id: page.id,
            user_id: user.id,
            visited_at: new Date(),
          })
          .execute();
      });
      return reply.status(204).send(null);
    },
  );

  r.get(
    "/me/recent",
    {
      config: { permission: "authenticated" as const },
      schema: { response: { 200: listOut } },
    },
    async (req) => {
      const user = requireUser(req);
      const pages = await db
        .selectFrom("pages_page as p")
        .innerJoin("pages_page_visit as v", "v.page_id", "p.id")
        .selectAll("p")
        .where("v.user_id", "=", user.id)
        .orderBy("v.visited_at", "desc")
        .limit(20)
        .execute();
      return visible(user, pages);
    },
  );

  // --- Blog ---------------------------------------------------------------------------

  r.get(
    "/spaces/:key/blog",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(20) }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              excerpt: z.string(),
              authorId: z.string(),
              createdAt: z.string(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const space = await db
        .selectFrom("pages_space")
        .select("id")
        .where("space_key", "=", req.params.key.toUpperCase())
        .executeTakeFirst();
      if (
        !space ||
        !(await access.can(req.user, "space.view", { spaceId: space.id }))
      )
        throw new AppError(404, "not_found", "Not found");
      const hidden = await access.hiddenPageIds(req.user, [space.id]);
      const posts = await db
        .selectFrom("pages_page")
        .selectAll()
        .where("space_id", "=", space.id)
        .where("kind", "=", "blog")
        .where("status", "=", "current")
        .orderBy("created_at", "desc")
        .limit(100)
        .execute();
      return posts
        .filter((p) => !hidden.has(p.id))
        .map((p) => ({
          id: p.id,
          title: p.title,
          excerpt: p.content_text.slice(0, 280),
          authorId: p.created_by,
          createdAt: p.created_at.toISOString(),
        }));
    },
  );

  // --- Notifications ------------------------------------------------------------------

  const watch = (pageId: string, userId: string) =>
    db
      .selectFrom("pages_page_watch")
      .select("page_id")
      .where("page_id", "=", pageId)
      .where("user_id", "=", userId)
      .executeTakeFirst()
      .then((known) =>
        known
          ? undefined
          : db
              .insertInto("pages_page_watch")
              .values({ page_id: pageId, user_id: userId })
              .execute(),
      );

  app.queue.on(
    "pages-notify",
    ["page.created", "page.updated", "page.commented", "page.mentioned"],
    async (event: StoredEvent) => {
      const page = await db
        .selectFrom("pages_page")
        .selectAll()
        .where("id", "=", event.entityId)
        .executeTakeFirst();
      if (!page) return;
      const candidates = new Set<string>();
      if (event.type === "page.mentioned") {
        for (const id of (event.payload as { userIds?: string[] }).userIds ??
          [])
          candidates.add(id);
      } else {
        // Who creates or comments on a page follows it from then on.
        if (
          event.actorId &&
          (event.type === "page.created" || event.type === "page.commented")
        )
          await watch(page.id, event.actorId);
        // A new page tells the watchers of its parent; anything else the watchers of the page.
        const watched =
          event.type === "page.created" ? page.parent_id : page.id;
        if (!watched) return;
        if (event.type === "page.updated") {
          const earlier = await core
            .selectFrom("core_event")
            .select("id")
            .where("entity_id", "=", page.id)
            .where("type", "=", "page.updated")
            .where("id", "<", event.id)
            .where(
              "created_at",
              ">",
              new Date(event.createdAt.getTime() - EDIT_QUIET_MS),
            )
            .executeTakeFirst();
          if (earlier) return;
        }
        for (const w of await db
          .selectFrom("pages_page_watch")
          .select("user_id")
          .where("page_id", "=", watched)
          .execute())
          candidates.add(w.user_id);
      }
      if (event.actorId) candidates.delete(event.actorId);
      if (!candidates.size) return;
      const users = await core
        .selectFrom("core_user")
        .selectAll()
        .where("id", "in", [...candidates])
        .where("active", "=", true)
        .execute();
      const recipients: string[] = [];
      for (const u of users)
        if (
          await sees(
            {
              id: u.id,
              email: u.email,
              displayName: u.display_name,
              kind: u.kind,
              locale: u.locale,
              timezone: u.timezone,
            },
            page,
          )
        )
          recipients.push(u.id);
      await app.notifier.notify(core, recipients, event.id);
    },
  );

  app.notifier.describe("page.", async (event, reader) => {
    const page = await db
      .selectFrom("pages_page")
      .selectAll()
      .where("id", "=", event.entityId)
      .executeTakeFirst();
    // Deleted, or no longer visible: the notification disappears.
    if (!page || page.status !== "current" || !(await sees(reader, page)))
      return null;
    const space = await db
      .selectFrom("pages_space")
      .select("space_key")
      .where("id", "=", page.space_id)
      .executeTakeFirstOrThrow();
    const t = reader.locale.startsWith("de") ? TEXT.de : TEXT.en;
    const actor = event.actorId
      ? (
          await core
            .selectFrom("core_user")
            .select("display_name")
            .where("id", "=", event.actorId)
            .executeTakeFirst()
        )?.display_name
      : undefined;
    const who = actor ?? t.someone;
    const text =
      event.type === "page.mentioned"
        ? t.mentioned(who)
        : event.type === "page.commented"
          ? t.commented(who)
          : event.type === "page.created"
            ? t.created(who)
            : t.updated(who);
    return {
      title: page.title,
      text,
      url: `/nuvenna/spaces/${space.space_key}/pages/${page.id}`,
    };
  });
}
