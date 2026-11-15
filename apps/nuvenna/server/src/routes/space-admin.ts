// Who may do what in a space, and restrictions on single pages. Every change
// is an event, so open editors are re-checked (collab.ts) at once.
import {
  AppError,
  requireUser,
  uuidv7,
  type AppContext,
  type AuthUser,
  type CoreDb,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import { SPACE_PERMISSIONS, type PagesAccess } from "../access.js";
import type { PagesDb } from "../db/schema.js";

const notFound = () => new AppError(404, "not_found", "Not found");

export async function spaceAdminRoutes(
  scope: FastifyInstance,
  app: AppContext,
  db: Kysely<PagesDb>,
  access: PagesAccess,
): Promise<void> {
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const custom = { permission: "custom" as const };
  const core = db as unknown as Kysely<CoreDb>;

  async function adminSpace(user: AuthUser, key: string) {
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
    await access.require(user, "space.administer", { spaceId: space.id });
    return space;
  }
  /** Names for user and group grantees, for showing a list. */
  async function names(ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const [users, groups] = await Promise.all([
      core
        .selectFrom("core_user")
        .select(["id", "display_name as name"])
        .where("id", "in", ids)
        .execute(),
      core
        .selectFrom("core_group")
        .select(["id", "name"])
        .where("id", "in", ids)
        .execute(),
    ]);
    return new Map([...users, ...groups].map((x) => [x.id, x.name]));
  }
  async function exists(type: "user" | "group", id: string) {
    const row =
      type === "user"
        ? await core
            .selectFrom("core_user")
            .select("id")
            .where("id", "=", id)
            .executeTakeFirst()
        : await core
            .selectFrom("core_group")
            .select("id")
            .where("id", "=", id)
            .executeTakeFirst();
    if (!row) throw new AppError(400, "validation", `Unknown ${type}`);
  }

  // --- Space permissions --------------------------------------------------------------

  const grantOut = z.object({
    id: z.string(),
    permission: z.enum(SPACE_PERMISSIONS),
    granteeType: z.enum(["user", "group", "logged_in", "anyone"]),
    granteeId: z.string().nullable(),
    name: z.string().nullable(),
  });

  r.get(
    "/spaces/:key/permissions",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(20) }),
        response: { 200: z.array(grantOut) },
      },
    },
    async (req) => {
      const space = await adminSpace(requireUser(req), req.params.key);
      const rows = await db
        .selectFrom("pages_space_permission")
        .selectAll()
        .where("space_id", "=", space.id)
        .execute();
      const named = await names(
        rows.flatMap((g) => (g.grantee_id ? [g.grantee_id] : [])),
      );
      return rows
        .map((g) => ({
          id: g.id,
          permission: g.permission as (typeof SPACE_PERMISSIONS)[number],
          granteeType: g.grantee_type,
          granteeId: g.grantee_id,
          name: g.grantee_id ? (named.get(g.grantee_id) ?? null) : null,
        }))
        .sort(
          (a, b) =>
            SPACE_PERMISSIONS.indexOf(a.permission) -
            SPACE_PERMISSIONS.indexOf(b.permission),
        );
    },
  );

  r.post(
    "/spaces/:key/permissions",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(20) }),
        body: z.discriminatedUnion("granteeType", [
          z.object({
            permission: z.enum(SPACE_PERMISSIONS),
            granteeType: z.enum(["user", "group"]),
            granteeId: z.string(),
          }),
          z.object({
            permission: z.enum(SPACE_PERMISSIONS),
            granteeType: z.enum(["logged_in", "anyone"]),
          }),
        ]),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const space = await adminSpace(user, req.params.key);
      const b = req.body;
      const granteeId = "granteeId" in b ? b.granteeId : null;
      if (granteeId) await exists(b.granteeType as "user" | "group", granteeId);
      let q = db
        .selectFrom("pages_space_permission")
        .select("id")
        .where("space_id", "=", space.id)
        .where("permission", "=", b.permission)
        .where("grantee_type", "=", b.granteeType);
      q = granteeId
        ? q.where("grantee_id", "=", granteeId)
        : q.where("grantee_id", "is", null);
      if (!(await q.executeTakeFirst()))
        await db.transaction().execute(async (trx) => {
          await trx
            .insertInto("pages_space_permission")
            .values({
              id: uuidv7(),
              space_id: space.id,
              permission: b.permission,
              grantee_type: b.granteeType,
              grantee_id: granteeId,
            })
            .execute();
          await app.queue.emit(trx as unknown as Kysely<CoreDb>, {
            type: "space.permissions_changed",
            actorId: user.id,
            entityType: "space",
            entityId: space.id,
          });
        });
      return reply.status(204).send(null);
    },
  );

  r.delete(
    "/spaces/:key/permissions/:id",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(20), id: z.string() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const space = await adminSpace(user, req.params.key);
      const grants = await db
        .selectFrom("pages_space_permission")
        .selectAll()
        .where("space_id", "=", space.id)
        .execute();
      const gone = grants.find((g) => g.id === req.params.id);
      if (!gone) throw notFound();
      // Someone must still be able to administer the space afterwards.
      if (
        gone.permission === "space.administer" &&
        grants.filter((g) => g.permission === "space.administer").length === 1
      )
        throw new AppError(
          409,
          "conflict",
          "The space needs at least one administrator",
        );
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("pages_space_permission")
          .where("id", "=", gone.id)
          .execute();
        await app.queue.emit(trx as unknown as Kysely<CoreDb>, {
          type: "space.permissions_changed",
          actorId: user.id,
          entityType: "space",
          entityId: space.id,
        });
      });
      return reply.status(204).send(null);
    },
  );

  // --- Page restrictions --------------------------------------------------------------

  const who = z.object({ type: z.enum(["user", "group"]), id: z.string() });
  const restrictionsOut = z.object({
    view: z.array(who.extend({ name: z.string().nullable() })),
    edit: z.array(who.extend({ name: z.string().nullable() })),
  });
  async function restrictionsOf(pageId: string) {
    const rows = await db
      .selectFrom("pages_page_restriction")
      .selectAll()
      .where("page_id", "=", pageId)
      .execute();
    const named = await names(rows.map((x) => x.grantee_id));
    const list = (kind: "view" | "edit") =>
      rows
        .filter((x) => x.kind === kind)
        .map((x) => ({
          type: x.grantee_type,
          id: x.grantee_id,
          name: named.get(x.grantee_id) ?? null,
        }));
    return { view: list("view"), edit: list("edit") };
  }
  async function visiblePage(user: AuthUser, id: string) {
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
    return page;
  }

  r.get(
    "/pages/:id/restrictions",
    {
      config: custom,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: restrictionsOut },
      },
    },
    async (req) =>
      restrictionsOf((await visiblePage(requireUser(req), req.params.id)).id),
  );

  r.put(
    "/pages/:id/restrictions",
    {
      config: custom,
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          view: z.array(who).max(100),
          edit: z.array(who).max(100),
        }),
        response: { 200: restrictionsOut },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const page = await visiblePage(user, req.params.id);
      // Whoever may change the page may decide who sees and changes it.
      await access.require(user, "space.edit", {
        spaceId: page.space_id,
        pageId: page.id,
      });
      const me = { type: "user" as const, id: user.id };
      // Nobody locks themselves out: a non-empty list always includes the one setting it.
      const withMe = (list: z.infer<typeof who>[]) => {
        const unique = [
          ...new Map(list.map((x) => [`${x.type}:${x.id}`, x])).values(),
        ];
        return unique.length &&
          !unique.some((x) => x.type === "user" && x.id === user.id)
          ? [...unique, me]
          : unique;
      };
      const view = withMe(req.body.view);
      const edit = withMe(req.body.edit);
      for (const x of [...view, ...edit]) await exists(x.type, x.id);
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("pages_page_restriction")
          .where("page_id", "=", page.id)
          .execute();
        const rows = [
          ...view.map((x) => ({ kind: "view" as const, ...x })),
          ...edit.map((x) => ({ kind: "edit" as const, ...x })),
        ];
        if (rows.length)
          await trx
            .insertInto("pages_page_restriction")
            .values(
              rows.map((x) => ({
                id: uuidv7(),
                page_id: page.id,
                kind: x.kind,
                grantee_type: x.type,
                grantee_id: x.id,
              })),
            )
            .execute();
        await app.queue.emit(trx as unknown as Kysely<CoreDb>, {
          type: "page.restricted",
          actorId: user.id,
          entityType: "page",
          entityId: page.id,
          payload: { spaceId: page.space_id },
        });
      });
      return restrictionsOf(page.id);
    },
  );
}
