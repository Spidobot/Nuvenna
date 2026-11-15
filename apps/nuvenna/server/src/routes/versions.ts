// Page versions (CONCEPT.md §6): one is made automatically when an editing
// session ends (the last editor leaves, or ten minutes without a change),
// and on request with a message. Two versions can be compared block by
// block. Restoring replaces the live content as an ordinary change, so
// everyone editing sees it and it becomes part of the history itself.
import {
  AppError,
  renderText,
  requireUser,
  sanitizeDoc,
  uuidv7,
  type AppContext,
  type AuthUser,
  type RichDoc,
  type RichNode,
} from "@tvn/core";
import type { Hocuspocus } from "@hocuspocus/server";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import * as Y from "yjs";
import { z } from "zod";
import type { PagesAccess } from "../access.js";
import type { PagesDb } from "../db/schema.js";
import { docToYdoc, FRAGMENT } from "../ydoc.js";

/** Quiet time after which an editing session counts as ended. */
export const SESSION_QUIET_MS = 10 * 60_000;

type Page = PagesDb["pages_page"];

/** Top-level blocks as lines of text, the unit of comparison. */
const blocks = (doc: RichDoc) =>
  (doc.content ?? []).map((b: RichNode) =>
    renderText({ type: "doc", content: [b] }).trim(),
  );

/** Longest common subsequence diff of two lists of lines. */
export function diffLines(a: string[], b: string[]) {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: { change: "same" | "removed" | "added"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ change: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!)
      out.push({ change: "removed", text: a[i++]! });
    else out.push({ change: "added", text: b[j++]! });
  }
  while (i < n) out.push({ change: "removed", text: a[i++]! });
  while (j < m) out.push({ change: "added", text: b[j++]! });
  return out;
}

export function installVersions(
  scope: FastifyInstance,
  app: AppContext,
  db: Kysely<PagesDb>,
  access: PagesAccess,
  hocuspocus: Hocuspocus,
) {
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const custom = { permission: "custom" as const };

  /** Records the page's current content as the next version, unless it equals the last one. */
  async function snapshot(
    page: Page,
    authorId: string,
    message: string | null,
    force = false,
  ) {
    const last = await db
      .selectFrom("pages_page_version")
      .select(["number", "content_json", "title"])
      .where("page_id", "=", page.id)
      .orderBy("number", "desc")
      .executeTakeFirst();
    if (
      !force &&
      last &&
      last.content_json === page.content_json &&
      last.title === page.title
    )
      return null;
    const number = (last?.number ?? 0) + 1;
    await db
      .insertInto("pages_page_version")
      .values({
        id: uuidv7(),
        page_id: page.id,
        number,
        title: page.title,
        content_json: page.content_json,
        author_id: authorId,
        message,
        created_at: new Date(),
      })
      .execute();
    return number;
  }

  /** Ends quiet sessions: pages changed since their last version and untouched for ten minutes. */
  async function closeQuietSessions(now = new Date()) {
    const pages = await db
      .selectFrom("pages_page")
      .selectAll()
      .where("status", "=", "current")
      .where("updated_at", "<=", new Date(now.getTime() - SESSION_QUIET_MS))
      .where("version", ">", 1)
      .execute();
    let made = 0;
    for (const p of pages) if (await snapshot(p, p.updated_by, null)) made++;
    return made;
  }
  app.queue.every("pages-version-sessions", 60_000, async () => {
    await closeQuietSessions();
  });

  // The last editor left: the session ended. Store first, then take the version.
  // An extension of its own: configure() would register every other hook a second time.
  hocuspocus.configuration.extensions.push({
    async onDisconnect({ documentName, clientsCount }) {
      if (clientsCount > 0) return;
      // While the app shuts down the database may already be closed; the next start catches up.
      await snapshotAfterSession(documentName).catch(() => undefined);
    },
  });
  async function snapshotAfterSession(documentName: string) {
    await hocuspocus.flushPendingStores();
    const page = await db
      .selectFrom("pages_page")
      .selectAll()
      .where("id", "=", documentName)
      .executeTakeFirst();
    if (page && page.version > 1) await snapshot(page, page.updated_by, null);
  }

  async function loadPage(
    user: AuthUser | null,
    id: string,
    permission: "space.view" | "space.edit" = "space.view",
  ) {
    const page = await db
      .selectFrom("pages_page")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (
      !page ||
      !(await access.can(user, "space.view", {
        spaceId: page.space_id,
        pageId: page.id,
      }))
    )
      throw new AppError(404, "not_found", "Not found");
    if (permission === "space.edit")
      await access.require(user, "space.edit", {
        spaceId: page.space_id,
        pageId: page.id,
      });
    return page;
  }
  const idParam = z.object({ id: z.string() });
  const versionParam = idParam.extend({
    number: z.coerce.number().int().min(1),
  });
  const versionOut = z.object({
    number: z.number(),
    title: z.string(),
    authorId: z.string(),
    message: z.string().nullable(),
    createdAt: z.string(),
  });

  r.get(
    "/pages/:id/versions",
    {
      config: custom,
      schema: { params: idParam, response: { 200: z.array(versionOut) } },
    },
    async (req) => {
      const page = await loadPage(req.user, req.params.id);
      const rows = await db
        .selectFrom("pages_page_version")
        .select(["number", "title", "author_id", "message", "created_at"])
        .where("page_id", "=", page.id)
        .orderBy("number", "desc")
        .execute();
      return rows.map((v) => ({
        number: v.number,
        title: v.title,
        authorId: v.author_id,
        message: v.message,
        createdAt: v.created_at.toISOString(),
      }));
    },
  );

  r.post(
    "/pages/:id/versions",
    {
      config: custom,
      schema: {
        params: idParam,
        body: z.object({ message: z.string().trim().min(1).max(500) }),
        response: { 201: z.object({ number: z.number() }) },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const page = await loadPage(user, req.params.id, "space.edit");
      // What people are typing right now belongs in the named version.
      await hocuspocus.flushPendingStores();
      const fresh = await loadPage(user, page.id);
      const number = (await snapshot(fresh, user.id, req.body.message, true))!;
      return reply.status(201).send({ number });
    },
  );

  r.get(
    "/pages/:id/versions/:number",
    {
      config: custom,
      schema: {
        params: versionParam,
        response: { 200: versionOut.extend({ content: z.unknown() }) },
      },
    },
    async (req) => {
      const page = await loadPage(req.user, req.params.id);
      const v = await db
        .selectFrom("pages_page_version")
        .selectAll()
        .where("page_id", "=", page.id)
        .where("number", "=", req.params.number)
        .executeTakeFirst();
      if (!v) throw new AppError(404, "not_found", "Not found");
      return {
        number: v.number,
        title: v.title,
        authorId: v.author_id,
        message: v.message,
        createdAt: v.created_at.toISOString(),
        content: JSON.parse(v.content_json),
      };
    },
  );

  /** Block-by-block comparison; "to" may be "current" for the live content. */
  r.get(
    "/pages/:id/compare",
    {
      config: custom,
      schema: {
        params: idParam,
        querystring: z.object({
          from: z.coerce.number().int().min(1),
          to: z.union([z.coerce.number().int().min(1), z.literal("current")]),
        }),
        response: {
          200: z.object({
            titles: z.tuple([z.string(), z.string()]),
            blocks: z.array(
              z.object({
                change: z.enum(["same", "removed", "added"]),
                text: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const page = await loadPage(req.user, req.params.id);
      const version = async (n: number) => {
        const v = await db
          .selectFrom("pages_page_version")
          .select(["title", "content_json"])
          .where("page_id", "=", page.id)
          .where("number", "=", n)
          .executeTakeFirst();
        if (!v) throw new AppError(404, "not_found", "Not found");
        return v;
      };
      const from = await version(req.query.from);
      const to =
        req.query.to === "current" ? page : await version(req.query.to);
      return {
        titles: [from.title, to.title] as [string, string],
        blocks: diffLines(
          blocks(JSON.parse(from.content_json)),
          blocks(JSON.parse(to.content_json)),
        ),
      };
    },
  );

  r.post(
    "/pages/:id/versions/:number/restore",
    {
      config: custom,
      schema: { params: versionParam, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const page = await loadPage(user, req.params.id, "space.edit");
      const v = await db
        .selectFrom("pages_page_version")
        .selectAll()
        .where("page_id", "=", page.id)
        .where("number", "=", req.params.number)
        .executeTakeFirst();
      if (!v) throw new AppError(404, "not_found", "Not found");
      const doc = sanitizeDoc(JSON.parse(v.content_json));
      // Through the live document: whoever is editing sees the old content arrive as a change.
      const connection = await hocuspocus.openDirectConnection(page.id, {
        user,
      });
      await connection.transact((document) => {
        const fragment = document.getXmlFragment(FRAGMENT);
        fragment.delete(0, fragment.length);
        const source = docToYdoc(doc).getXmlFragment(FRAGMENT);
        fragment.insert(
          0,
          source.toArray().map((item) => (item as Y.XmlElement).clone()),
        );
      });
      await connection.disconnect();
      await hocuspocus.flushPendingStores();
      if (v.title !== page.title)
        await db
          .updateTable("pages_page")
          .set({ title: v.title, updated_by: user.id, updated_at: new Date() })
          .where("id", "=", page.id)
          .execute();
      await app.queue.emit(db as never, {
        type: "page.restored_version",
        actorId: user.id,
        entityType: "page",
        entityId: page.id,
        payload: { spaceId: page.space_id, title: v.title, number: v.number },
      });
      return reply.status(204).send(null);
    },
  );

  return { closeQuietSessions, snapshot };
}
