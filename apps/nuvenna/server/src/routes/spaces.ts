// Spaces and their page tree: create, rename, move, copy with sub-pages,
// reorder, trash and restore. Content is edited together in real time (P-3);
// here pages are only created empty and moved around.
import {
  AppError,
  markdownToDoc,
  renderText,
  requireUser,
  RichTextError,
  sanitizeDoc,
  uuidv7,
  type AppContext,
  type AuthUser,
  type CoreDb,
  type RichDoc,
} from "@tvn/core";
import { builtInTemplates } from "../templates.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely, Selectable, Transaction } from "kysely";
import { z } from "zod";
import {
  SPACE_PERMISSIONS,
  type PagesAccess,
  type SpacePermission,
} from "../access.js";
import type { PagesDb } from "../db/schema.js";

type Db = Kysely<PagesDb> | Transaction<PagesDb>;
type Page = PagesDb["pages_page"];
const EMPTY_DOC = JSON.stringify({ type: "doc", content: [] });
const notFound = () => new AppError(404, "not_found", "Not found");

const spaceKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z][A-Z0-9]{1,19}$/,
    "2 to 20 letters and digits, starting with a letter",
  );

export async function spaceRoutes(
  scope: FastifyInstance,
  app: AppContext,
  db: Kysely<PagesDb>,
  access: PagesAccess,
): Promise<void> {
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const custom = { permission: "custom" as const };
  const emit = (
    trx: Db,
    type: string,
    actor: AuthUser,
    page: { id: string; space_id: string; title: string },
  ) =>
    app.queue.emit(trx as unknown as Kysely<CoreDb>, {
      type,
      actorId: actor.id,
      entityType: "page",
      entityId: page.id,
      payload: { spaceId: page.space_id, title: page.title },
    });

  async function loadSpace(
    user: AuthUser | null,
    key: string,
    permission: SpacePermission = "space.view",
  ) {
    const space = await db
      .selectFrom("pages_space")
      .selectAll()
      .where("space_key", "=", key.toUpperCase())
      .executeTakeFirst();
    if (
      !space ||
      !(await access.can(user, "space.view", { spaceId: space.id }))
    )
      throw notFound();
    if (permission !== "space.view")
      await access.require(user, permission, { spaceId: space.id });
    return space;
  }
  async function loadPage(
    user: AuthUser | null,
    id: string,
    permission: SpacePermission = "space.view",
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
      throw notFound();
    if (permission !== "space.view")
      await access.require(user, permission, {
        spaceId: page.space_id,
        pageId: page.id,
      });
    return page;
  }
  /** Ids of a page and everything below it. */
  async function subtree(q: Db, rootId: string): Promise<string[]> {
    const out: string[] = [];
    for (let level = [rootId]; level.length;) {
      out.push(...level);
      level = (
        await q
          .selectFrom("pages_page")
          .select("id")
          .where("parent_id", "in", level)
          .execute()
      ).map((p) => p.id);
    }
    return out;
  }
  /** Puts a page at `position` among its new siblings and closes the gap it left. */
  async function place(
    trx: Db,
    page: Page,
    spaceId: string,
    parentId: string | null,
    position: number | null,
  ) {
    const siblings = (
      await trx
        .selectFrom("pages_page")
        .select("id")
        .where("space_id", "=", spaceId)
        .where("status", "=", "current")
        .where((eb) =>
          parentId
            ? eb("parent_id", "=", parentId)
            : eb("parent_id", "is", null),
        )
        .where("id", "!=", page.id)
        .orderBy("position")
        .execute()
    ).map((s) => s.id);
    const at =
      position === null
        ? siblings.length
        : Math.max(0, Math.min(position, siblings.length));
    siblings.splice(at, 0, page.id);
    for (const [i, id] of siblings.entries())
      await trx
        .updateTable("pages_page")
        .set({ position: i })
        .where("id", "=", id)
        .execute();
  }
  const pageOut = z.object({
    id: z.string(),
    spaceKey: z.string(),
    parentId: z.string().nullable(),
    position: z.number(),
    title: z.string(),
    kind: z.enum(["page", "blog", "template"]),
    status: z.enum(["current", "trashed"]),
    version: z.number(),
    content: z.unknown(),
    updatedBy: z.string(),
    updatedAt: z.string(),
  });
  const present = (p: Page, key: string) => ({
    id: p.id,
    spaceKey: key,
    parentId: p.parent_id,
    position: p.position,
    title: p.title,
    kind: p.kind,
    status: p.status,
    version: p.version,
    content: JSON.parse(p.content_json),
    updatedBy: p.updated_by,
    updatedAt: p.updated_at.toISOString(),
  });
  const keyOf = async (spaceId: string) =>
    (
      await db
        .selectFrom("pages_space")
        .select("space_key")
        .where("id", "=", spaceId)
        .executeTakeFirstOrThrow()
    ).space_key;
  async function newPage(
    trx: Db,
    actor: AuthUser,
    spaceId: string,
    parentId: string | null,
    title: string,
    kind: Page["kind"],
    content = EMPTY_DOC,
    text = "",
  ) {
    const now = new Date();
    const page: Page = {
      id: uuidv7(),
      space_id: spaceId,
      parent_id: parentId,
      position: 0,
      title,
      kind,
      status: "current",
      version: 1,
      content_json: content,
      content_text: text,
      created_by: actor.id,
      created_at: now,
      updated_by: actor.id,
      updated_at: now,
      trashed_at: null,
    };
    await trx.insertInto("pages_page").values(page).execute();
    await place(trx, page, spaceId, parentId, null);
    await emit(trx, "page.created", actor, page);
    return page;
  }

  // --- Spaces -------------------------------------------------------------------------

  const spaceOut = z.object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    description: z.string(),
    homePageId: z.string().nullable(),
    archived: z.boolean(),
    knowledgeBase: z.boolean(),
    /** What the caller may do here. */
    rights: z.array(z.enum(SPACE_PERMISSIONS)),
  });
  const presentSpace = async (
    user: AuthUser | null,
    s: Selectable<PagesDb["pages_space"]>,
  ) => ({
    id: s.id,
    key: s.space_key,
    name: s.name,
    description: s.description,
    homePageId: s.home_page_id,
    archived: Boolean(s.archived),
    knowledgeBase: Boolean(s.knowledge_base),
    rights: (
      await Promise.all(
        SPACE_PERMISSIONS.map(async (p) =>
          (await access.can(user, p, { spaceId: s.id })) ? p : null,
        ),
      )
    ).filter((p): p is SpacePermission => p !== null),
  });

  r.get(
    "/spaces",
    {
      config: { permission: "authenticated" as const },
      schema: { response: { 200: z.array(spaceOut) } },
    },
    async (req) => {
      const ids = await access.visibleSpaceIds(req.user);
      if (!ids.length) return [];
      const spaces = await db
        .selectFrom("pages_space")
        .selectAll()
        .where("id", "in", ids)
        .orderBy("name")
        .execute();
      return Promise.all(spaces.map((s) => presentSpace(req.user, s)));
    },
  );

  r.post(
    "/spaces",
    {
      config: { permission: "space.create" },
      schema: {
        body: z.object({
          key: spaceKey,
          name: z.string().trim().min(1).max(200),
          description: z.string().max(2000).default(""),
        }),
        response: { 201: spaceOut },
      },
    },
    async (req, reply) => {
      const actor = requireUser(req);
      const taken = await db
        .selectFrom("pages_space")
        .select("id")
        .where("space_key", "=", req.body.key)
        .executeTakeFirst();
      if (taken) throw new AppError(409, "conflict", "This key is taken");
      const id = uuidv7();
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("pages_space")
          .values({
            id,
            space_key: req.body.key,
            name: req.body.name,
            description: req.body.description,
            home_page_id: null,
            archived: false,
            knowledge_base: false,
            created_at: new Date(),
          })
          .execute();
        // Everyone signed in reads and comments, the creator does everything.
        const grants = [
          ...["space.view", "space.comment"].map((permission) => ({
            permission,
            grantee_type: "logged_in" as const,
            grantee_id: null,
          })),
          ...SPACE_PERMISSIONS.map((permission) => ({
            permission,
            grantee_type: "user" as const,
            grantee_id: actor.id,
          })),
        ];
        await trx
          .insertInto("pages_space_permission")
          .values(grants.map((g) => ({ id: uuidv7(), space_id: id, ...g })))
          .execute();
        const home = await newPage(trx, actor, id, null, req.body.name, "page");
        await trx
          .updateTable("pages_space")
          .set({ home_page_id: home.id })
          .where("id", "=", id)
          .execute();
        await app.queue.emit(trx as unknown as Kysely<CoreDb>, {
          type: "space.created",
          actorId: actor.id,
          entityType: "space",
          entityId: id,
        });
      });
      const space = await db
        .selectFrom("pages_space")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return reply.status(201).send(await presentSpace(actor, space));
    },
  );

  r.get(
    "/spaces/:key",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(20) }),
        response: { 200: spaceOut },
      },
    },
    async (req) =>
      presentSpace(req.user, await loadSpace(req.user, req.params.key)),
  );

  r.patch(
    "/spaces/:key",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(20) }),
        body: z
          .object({
            name: z.string().trim().min(1).max(200),
            description: z.string().max(2000),
            archived: z.boolean(),
            knowledgeBase: z.boolean(),
            homePageId: z.string().nullable(),
          })
          .partial(),
        response: { 200: spaceOut },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const space = await loadSpace(user, req.params.key, "space.administer");
      if (req.body.homePageId) {
        const home = await db
          .selectFrom("pages_page")
          .select("space_id")
          .where("id", "=", req.body.homePageId)
          .executeTakeFirst();
        if (home?.space_id !== space.id)
          throw new AppError(
            400,
            "validation",
            "The home page must be a page of this space",
          );
      }
      const { name, description, archived, homePageId, knowledgeBase } =
        req.body;
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("pages_space")
          .set({
            ...(name !== undefined && { name }),
            ...(description !== undefined && { description }),
            ...(archived !== undefined && { archived }),
            ...(knowledgeBase !== undefined && {
              knowledge_base: knowledgeBase,
            }),
            ...(homePageId !== undefined && { home_page_id: homePageId }),
          })
          .where("id", "=", space.id)
          .execute();
        await app.queue.emit(trx as unknown as Kysely<CoreDb>, {
          type: "space.updated",
          actorId: user.id,
          entityType: "space",
          entityId: space.id,
          payload: req.body,
        });
      });
      return presentSpace(
        user,
        await db
          .selectFrom("pages_space")
          .selectAll()
          .where("id", "=", space.id)
          .executeTakeFirstOrThrow(),
      );
    },
  );

  // --- The tree -----------------------------------------------------------------------

  const treeNode = z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    position: z.number(),
    title: z.string(),
    kind: z.enum(["page", "blog", "template"]),
  });
  /** Pages of a space the user may see, with a given status. */
  async function visiblePages(
    user: AuthUser | null,
    spaceId: string,
    status: Page["status"],
  ) {
    const hidden = await access.hiddenPageIds(user, [spaceId]);
    const pages = await db
      .selectFrom("pages_page")
      .selectAll()
      .where("space_id", "=", spaceId)
      .where("status", "=", status)
      .orderBy("position")
      .execute();
    return pages.filter((p) => !hidden.has(p.id));
  }

  r.get(
    "/spaces/:key/tree",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(20) }),
        response: { 200: z.array(treeNode) },
      },
    },
    async (req) => {
      const space = await loadSpace(req.user, req.params.key);
      const pages = await visiblePages(req.user, space.id, "current");
      const ids = new Set(pages.map((p) => p.id));
      return (
        pages
          // A page whose parent is in the trash stays out of the tree with it.
          .filter((p) => !p.parent_id || ids.has(p.parent_id))
          // Blog posts and templates have their own tabs.
          .filter((p) => p.kind === "page")
          .map((p) => ({
            id: p.id,
            parentId: p.parent_id,
            position: p.position,
            title: p.title,
            kind: p.kind,
          }))
      );
    },
  );

  r.post(
    "/spaces/:key/pages",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(20) }),
        body: z.object({
          title: z.string().trim().min(1).max(500),
          parentId: z.string().nullable().default(null),
          kind: z.enum(["page", "blog", "template"]).default("page"),
          /** "builtin:<key>" or the id of a template page in this space. */
          templateId: z.string().max(100).optional(),
          /** Starting content, e.g. a ticket block when Tickvana makes a page for a ticket. */
          content: z.unknown().optional(),
        }),
        response: { 201: pageOut },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const space = await loadSpace(user, req.params.key, "space.edit");
      if (req.body.parentId) {
        const parent = await loadPage(user, req.body.parentId);
        if (parent.space_id !== space.id || parent.status !== "current")
          throw new AppError(
            400,
            "validation",
            "Choose a page of this space as parent",
          );
      }
      let content: string | undefined, text: string | undefined;
      const tid = req.body.templateId;
      if (tid) {
        const builtIn = builtInTemplates(user.locale).find((t) => t.id === tid);
        const doc = builtIn
          ? builtIn.content
          : await loadPage(user, tid).then((t) => {
              if (t.kind !== "template" || t.space_id !== space.id)
                throw new AppError(
                  400,
                  "validation",
                  "Not a template of this space",
                );
              return JSON.parse(t.content_json) as RichDoc;
            });
        content = JSON.stringify(doc);
        text = renderText(doc);
      } else if (req.body.content !== undefined) {
        let doc: RichDoc;
        try {
          doc = sanitizeDoc(req.body.content);
        } catch (e) {
          throw e instanceof RichTextError
            ? new AppError(400, "validation", e.message)
            : e;
        }
        content = JSON.stringify(doc);
        text = renderText(doc);
      }
      const page = await db
        .transaction()
        .execute((trx) =>
          newPage(
            trx,
            user,
            space.id,
            req.body.parentId,
            req.body.title,
            req.body.kind,
            content,
            text,
          ),
        );
      return reply.status(201).send(present(page, space.space_key));
    },
  );

  // A folder of Markdown files becomes pages: each folder a page (its
  // index.md or README.md as content), each other file a page below it.
  r.post(
    "/spaces/:key/import",
    {
      config: custom,
      bodyLimit: 20 * 1024 * 1024,
      schema: {
        params: z.object({ key: z.string().max(20) }),
        body: z.object({
          parentId: z.string().nullable().default(null),
          files: z
            .array(
              z.object({
                path: z.string().min(1).max(1000),
                content: z.string().max(1024 * 1024),
              }),
            )
            .min(1)
            .max(1000),
        }),
        response: { 201: z.object({ created: z.number() }) },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const space = await loadSpace(user, req.params.key, "space.edit");
      const parentId = req.body.parentId ?? space.home_page_id;
      if (parentId) {
        const parent = await loadPage(user, parentId);
        if (parent.space_id !== space.id || parent.status !== "current")
          throw new AppError(
            400,
            "validation",
            "Choose a page of this space as parent",
          );
      }
      const files = req.body.files
        .map((f) => ({
          ...f,
          parts: f.path
            .split(/[\\/]/)
            .filter((s) => s && s !== "." && s !== ".."),
        }))
        .filter(
          (f) => f.parts.length && /\.(md|markdown)$/i.test(f.parts.at(-1)!),
        )
        .sort((a, b) => a.parts.join("/").localeCompare(b.parts.join("/")));
      if (!files.length)
        throw new AppError(400, "validation", "No Markdown files");
      const isIndex = (name: string) =>
        /^(index|readme)\.(md|markdown)$/i.test(name);
      let created = 0;
      await db.transaction().execute(async (trx) => {
        const folders = new Map<string, string | null>([["", parentId]]);
        const add = (parent: string | null, fallback: string, md: string) => {
          let parsed;
          try {
            parsed = markdownToDoc(md);
          } catch (e) {
            throw e instanceof RichTextError
              ? new AppError(400, "validation", `${fallback}: ${e.message}`)
              : e;
          }
          const { title, doc } = parsed;
          created++;
          return newPage(
            trx,
            user,
            space.id,
            parent,
            (title ?? fallback).slice(0, 500),
            "page",
            JSON.stringify(doc),
            renderText(doc),
          );
        };
        const folder = async (dirs: string[]): Promise<string | null> => {
          const key = dirs.join("/");
          if (folders.has(key)) return folders.get(key)!;
          const parent = await folder(dirs.slice(0, -1));
          const index = files.find(
            (f) =>
              f.parts.length === dirs.length + 1 &&
              f.parts.slice(0, -1).join("/") === key &&
              isIndex(f.parts.at(-1)!),
          );
          const page = await add(parent, dirs.at(-1)!, index?.content ?? "");
          folders.set(key, page.id);
          return page.id;
        };
        for (const f of files) {
          const dirs = f.parts.slice(0, -1);
          const name = f.parts.at(-1)!;
          if (isIndex(name) && dirs.length) {
            await folder(dirs);
            continue;
          }
          await add(
            await folder(dirs),
            name.replace(/\.(md|markdown)$/i, ""),
            f.content,
          );
        }
      });
      return reply.status(201).send({ created });
    },
  );

  r.get(
    "/spaces/:key/templates",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(20) }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              description: z.string(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const space = await loadSpace(user, req.params.key);
      const own = (await visiblePages(user, space.id, "current"))
        .filter((p) => p.kind === "template")
        .map((p) => ({
          id: p.id,
          title: p.title,
          description: p.content_text.slice(0, 120),
        }));
      return [
        ...builtInTemplates(user.locale).map(({ id, title, description }) => ({
          id,
          title,
          description,
        })),
        ...own,
      ];
    },
  );

  r.get(
    "/pages/:id",
    {
      config: custom,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: pageOut },
      },
    },
    async (req) => {
      const page = await loadPage(req.user, req.params.id);
      return present(page, await keyOf(page.space_id));
    },
  );

  r.patch(
    "/pages/:id",
    {
      config: custom,
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ title: z.string().trim().min(1).max(500) }),
        response: { 200: pageOut },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const page = await loadPage(user, req.params.id, "space.edit");
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("pages_page")
          .set({
            title: req.body.title,
            updated_by: user.id,
            updated_at: new Date(),
          })
          .where("id", "=", page.id)
          .execute();
        await emit(trx, "page.renamed", user, {
          ...page,
          title: req.body.title,
        });
      });
      return present(await loadPage(user, page.id), await keyOf(page.space_id));
    },
  );

  r.post(
    "/pages/:id/move",
    {
      config: custom,
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          /** Another space; leave out to stay. */
          spaceKey: z.string().max(20).optional(),
          parentId: z.string().nullable(),
          position: z.number().int().min(0).nullable().default(null),
        }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const page = await loadPage(user, req.params.id, "space.edit");
      const target = req.body.spaceKey
        ? await loadSpace(user, req.body.spaceKey, "space.edit")
        : { id: page.space_id };
      const below = await subtree(db, page.id);
      if (req.body.parentId) {
        if (below.includes(req.body.parentId))
          throw new AppError(
            400,
            "validation",
            "A page cannot move below itself",
          );
        const parent = await loadPage(user, req.body.parentId);
        if (parent.space_id !== target.id || parent.status !== "current")
          throw new AppError(
            400,
            "validation",
            "Choose a page of the target space as parent",
          );
      }
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("pages_page")
          .set({ parent_id: req.body.parentId })
          .where("id", "=", page.id)
          .execute();
        // Sub-pages go along to the other space.
        if (target.id !== page.space_id)
          await trx
            .updateTable("pages_page")
            .set({ space_id: target.id })
            .where("id", "in", below)
            .execute();
        await place(trx, page, target.id, req.body.parentId, req.body.position);
        // Close the gap in the old place.
        const old = await trx
          .selectFrom("pages_page")
          .select("id")
          .where("space_id", "=", page.space_id)
          .where("status", "=", "current")
          .where((eb) =>
            page.parent_id
              ? eb("parent_id", "=", page.parent_id)
              : eb("parent_id", "is", null),
          )
          .orderBy("position")
          .execute();
        for (const [i, s] of old.entries())
          await trx
            .updateTable("pages_page")
            .set({ position: i })
            .where("id", "=", s.id)
            .execute();
        await emit(trx, "page.moved", user, { ...page, space_id: target.id });
      });
      return reply.status(204).send(null);
    },
  );

  r.post(
    "/pages/:id/copy",
    {
      config: custom,
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          parentId: z.string().nullable(),
          spaceKey: z.string().max(20).optional(),
          withChildren: z.boolean().default(true),
          title: z.string().trim().min(1).max(500).optional(),
        }),
        response: { 201: pageOut },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const source = await loadPage(user, req.params.id);
      const target = req.body.spaceKey
        ? await loadSpace(user, req.body.spaceKey, "space.edit")
        : await loadSpace(user, await keyOf(source.space_id), "space.edit");
      if (req.body.parentId) {
        const parent = await loadPage(user, req.body.parentId);
        if (parent.space_id !== target.id)
          throw new AppError(
            400,
            "validation",
            "Choose a page of the target space as parent",
          );
      }
      const hidden = await access.hiddenPageIds(user, [source.space_id]);
      const copy = await db.transaction().execute(async (trx) => {
        const walk = async (
          from: Page,
          parentId: string | null,
          title: string,
        ): Promise<Page> => {
          const made = await newPage(
            trx,
            user,
            target.id,
            parentId,
            title,
            from.kind,
            from.content_json,
            from.content_text,
          );
          if (req.body.withChildren) {
            const children = await trx
              .selectFrom("pages_page")
              .selectAll()
              .where("parent_id", "=", from.id)
              .where("status", "=", "current")
              .orderBy("position")
              .execute();
            // Only what the user can see is copied.
            for (const c of children)
              if (!hidden.has(c.id)) await walk(c, made.id, c.title);
          }
          return made;
        };
        return walk(source, req.body.parentId, req.body.title ?? source.title);
      });
      return reply.status(201).send(present(copy, target.space_key));
    },
  );

  // --- Trash --------------------------------------------------------------------------

  r.delete(
    "/pages/:id",
    { config: custom, schema: { params: z.object({ id: z.string() }) } },
    async (req, reply) => {
      const user = requireUser(req);
      const page = await loadPage(user, req.params.id, "space.delete");
      const space = await db
        .selectFrom("pages_space")
        .select("home_page_id")
        .where("id", "=", page.space_id)
        .executeTakeFirstOrThrow();
      if (space.home_page_id === page.id)
        throw new AppError(
          409,
          "conflict",
          "The home page of a space cannot go to the trash",
        );
      const ids = await subtree(db, page.id);
      await db.transaction().execute(async (trx) => {
        const now = new Date();
        await trx
          .updateTable("pages_page")
          .set({ status: "trashed", trashed_at: now })
          .where("id", "in", ids)
          .where("status", "=", "current")
          .execute();
        await emit(trx, "page.trashed", user, page);
      });
      return reply.status(204).send(null);
    },
  );

  r.get(
    "/spaces/:key/trash",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(20) }),
        response: { 200: z.array(treeNode.extend({ trashedAt: z.string() })) },
      },
    },
    async (req) => {
      const space = await loadSpace(req.user, req.params.key, "space.delete");
      const pages = await visiblePages(req.user, space.id, "trashed");
      const trashed = new Set(pages.map((p) => p.id));
      // What was thrown away, not every page that went along with it.
      return pages
        .filter((p) => !p.parent_id || !trashed.has(p.parent_id))
        .map((p) => ({
          id: p.id,
          parentId: p.parent_id,
          position: p.position,
          title: p.title,
          kind: p.kind,
          trashedAt: p.trashed_at!.toISOString(),
        }));
    },
  );

  r.post(
    "/pages/:id/restore",
    {
      config: custom,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const page = await loadPage(user, req.params.id, "space.delete");
      if (page.status !== "trashed")
        throw new AppError(409, "conflict", "The page is not in the trash");
      const ids = await subtree(db, page.id);
      await db.transaction().execute(async (trx) => {
        // Pages that went to the trash together come back together.
        await trx
          .updateTable("pages_page")
          .set({ status: "current", trashed_at: null })
          .where("id", "in", ids)
          .where("trashed_at", "=", page.trashed_at)
          .execute();
        const parent = page.parent_id
          ? await trx
              .selectFrom("pages_page")
              .select("status")
              .where("id", "=", page.parent_id)
              .executeTakeFirst()
          : null;
        // Its parent is gone: it comes back at the top of the space.
        const parentId = parent?.status === "current" ? page.parent_id : null;
        await trx
          .updateTable("pages_page")
          .set({ parent_id: parentId })
          .where("id", "=", page.id)
          .execute();
        await place(trx, page, page.space_id, parentId, null);
        await emit(trx, "page.restored", user, page);
      });
      return reply.status(204).send(null);
    },
  );

  r.delete(
    "/pages/:id/purge",
    { config: custom, schema: { params: z.object({ id: z.string() }) } },
    async (req, reply) => {
      const user = requireUser(req);
      const page = await loadPage(user, req.params.id, "space.administer");
      if (page.status !== "trashed")
        throw new AppError(
          409,
          "conflict",
          "Only pages in the trash can be deleted for good",
        );
      const ids = await subtree(db, page.id);
      await db.transaction().execute(async (trx) => {
        // Deepest first, so no page points at a deleted parent.
        for (const id of [...ids].reverse())
          await trx.deleteFrom("pages_page").where("id", "=", id).execute();
        await emit(trx, "page.deleted", user, page);
      });
      return reply.status(204).send(null);
    },
  );
}
