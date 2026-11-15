// Comments on a page, as threads: on the whole page or on a passage of its
// text. Threads can be resolved. Mentions in a comment become an event, so
// notifications pick them up (CLAUDE.md: everything downstream runs off
// core_event).
import {
  AppError,
  renderText,
  requireUser,
  RichTextError,
  sanitizeDoc,
  uuidv7,
  type AppContext,
  type AuthUser,
  type CoreDb,
  type RichNode,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { PagesAccess } from "../access.js";
import type { PagesDb } from "../db/schema.js";

type Comment = PagesDb["pages_page_comment"];

/** Ids of the people mentioned in a document. */
export const mentionsOf = (doc: RichNode): string[] => {
  const out = new Set<string>();
  const walk = (n: RichNode) => {
    if (n.type === "mention" && typeof n.attrs?.id === "string")
      out.add(n.attrs.id);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return [...out];
};

/**
 * Where a comment sits in the text. ponytail: anchored by the quoted
 * passage, not by a position in the shared document; the passage is found
 * again by its text. Enough until edits often move commented passages.
 */
const anchor = z.object({ quote: z.string().trim().min(1).max(1000) });

export async function commentRoutes(
  scope: FastifyInstance,
  app: AppContext,
  db: Kysely<PagesDb>,
  access: PagesAccess,
): Promise<void> {
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const custom = { permission: "custom" as const };

  async function loadPage(user: AuthUser | null, id: string) {
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
    return page;
  }
  async function loadComment(user: AuthUser, id: string) {
    const c = await db
      .selectFrom("pages_page_comment")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!c) throw new AppError(404, "not_found", "Not found");
    const page = await loadPage(user, c.page_id);
    return { c, page };
  }
  const docOf = (value: unknown) => {
    try {
      const doc = sanitizeDoc(value);
      const text = renderText(doc);
      if (!text.trim())
        throw new AppError(400, "validation", "Comment is empty");
      return { doc, json: JSON.stringify(doc), text };
    } catch (e) {
      throw e instanceof RichTextError
        ? new AppError(400, "validation", e.message)
        : e;
    }
  };
  const out = z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    anchor: anchor.nullable(),
    body: z.unknown(),
    authorId: z.string(),
    resolved: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });
  const present = (c: Comment) => ({
    id: c.id,
    parentId: c.parent_id,
    anchor: c.anchor_json ? JSON.parse(c.anchor_json) : null,
    body: JSON.parse(c.body_json),
    authorId: c.author_id,
    resolved: Boolean(c.resolved),
    createdAt: c.created_at.toISOString(),
    updatedAt: c.updated_at.toISOString(),
  });
  const emit = (
    trx: Kysely<PagesDb>,
    type: string,
    user: AuthUser,
    page: PagesDb["pages_page"],
    payload: object,
  ) =>
    app.queue.emit(trx as unknown as Kysely<CoreDb>, {
      type,
      actorId: user.id,
      entityType: "page",
      entityId: page.id,
      payload: { spaceId: page.space_id, title: page.title, ...payload },
    });

  r.get(
    "/pages/:id/comments",
    {
      config: custom,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.array(out) },
      },
    },
    async (req) => {
      const page = await loadPage(req.user, req.params.id);
      return (
        await db
          .selectFrom("pages_page_comment")
          .selectAll()
          .where("page_id", "=", page.id)
          .orderBy("id")
          .execute()
      ).map(present);
    },
  );

  r.post(
    "/pages/:id/comments",
    {
      config: custom,
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          body: z.unknown(),
          parentId: z.string().nullable().default(null),
          anchor: anchor.nullable().default(null),
        }),
        response: { 201: out },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const page = await loadPage(user, req.params.id);
      await access.require(user, "space.comment", {
        spaceId: page.space_id,
        pageId: page.id,
      });
      if (req.body.parentId) {
        const parent = await db
          .selectFrom("pages_page_comment")
          .select(["page_id", "parent_id"])
          .where("id", "=", req.body.parentId)
          .executeTakeFirst();
        // Replies hang on the thread's first comment; threads are one level deep.
        if (!parent || parent.page_id !== page.id || parent.parent_id)
          throw new AppError(
            400,
            "validation",
            "Reply to a thread of this page",
          );
      }
      const body = docOf(req.body.body);
      const now = new Date();
      const row: Comment = {
        id: uuidv7(),
        page_id: page.id,
        parent_id: req.body.parentId,
        anchor_json:
          req.body.parentId || !req.body.anchor
            ? null
            : JSON.stringify(req.body.anchor),
        body_json: body.json,
        body_text: body.text,
        author_id: user.id,
        resolved: false,
        created_at: now,
        updated_at: now,
      };
      const mentioned = mentionsOf(body.doc).filter((id) => id !== user.id);
      await db.transaction().execute(async (trx) => {
        await trx.insertInto("pages_page_comment").values(row).execute();
        await emit(trx, "page.commented", user, page, { commentId: row.id });
        if (mentioned.length)
          await emit(trx, "page.mentioned", user, page, {
            commentId: row.id,
            userIds: mentioned,
          });
      });
      return reply.status(201).send(present(row));
    },
  );

  r.patch(
    "/comments/:id",
    {
      config: custom,
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ body: z.unknown(), resolved: z.boolean() }).partial(),
        response: { 200: out },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const { c, page } = await loadComment(user, req.params.id);
      const target = { spaceId: page.space_id, pageId: page.id };
      const next: Partial<Comment> = { updated_at: new Date() };
      if (req.body.body !== undefined) {
        // Only the author changes what they wrote.
        if (c.author_id !== user.id)
          throw new AppError(
            403,
            "forbidden",
            "Only the author edits a comment",
          );
        const body = docOf(req.body.body);
        next.body_json = body.json;
        next.body_text = body.text;
      }
      if (req.body.resolved !== undefined) {
        // Resolving a thread: its author, or anyone who may edit the page.
        if (c.parent_id)
          throw new AppError(
            400,
            "validation",
            "Resolve the thread, not a reply",
          );
        if (c.author_id !== user.id)
          await access.require(user, "space.edit", target);
        next.resolved = req.body.resolved;
      }
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("pages_page_comment")
          .set(next)
          .where("id", "=", c.id)
          .execute();
        if (req.body.resolved !== undefined)
          await emit(
            trx,
            req.body.resolved
              ? "page.comment_resolved"
              : "page.comment_reopened",
            user,
            page,
            { commentId: c.id },
          );
      });
      return present({ ...c, ...next } as Comment);
    },
  );

  r.delete(
    "/comments/:id",
    { config: custom, schema: { params: z.object({ id: z.string() }) } },
    async (req, reply) => {
      const user = requireUser(req);
      const { c, page } = await loadComment(user, req.params.id);
      if (c.author_id !== user.id)
        await access.require(user, "space.administer", {
          spaceId: page.space_id,
          pageId: page.id,
        });
      // Replies go with their thread (on delete cascade).
      await db
        .deleteFrom("pages_page_comment")
        .where("id", "=", c.id)
        .execute();
      return reply.status(204).send(null);
    },
  );
}
