// Who may do what in Nuvenna (CONCEPT.md §5): rights per space, and page
// restrictions on top. A view restriction applies to the page and everything
// below it; an edit restriction only to the page itself.
import type { AuthUser, Permissions } from "@tvn/core";
import type { Kysely } from "kysely";
import type { PagesDb } from "./db/schema.js";

export const SPACE_PERMISSIONS = [
  "space.view",
  "space.edit",
  "space.delete",
  "space.comment",
  "space.administer",
] as const;
export type SpacePermission = (typeof SPACE_PERMISSIONS)[number];

/** What a space-scoped check is made against. Pass `pageId` for anything about one page. */
export interface SpaceTarget {
  spaceId: string;
  pageId?: string;
}

export interface PagesAccess {
  can(
    user: AuthUser | null,
    permission: SpacePermission,
    target: SpaceTarget,
  ): Promise<boolean>;
  require(
    user: AuthUser | null,
    permission: SpacePermission,
    target: SpaceTarget,
  ): Promise<void>;
  /** Spaces the user may view, for lists and the query engine. */
  visibleSpaceIds(user: AuthUser | null): Promise<string[]>;
  /** Pages in these spaces that view restrictions hide from the user (with everything below them). */
  hiddenPageIds(
    user: AuthUser | null,
    spaceIds: string[],
  ): Promise<Set<string>>;
}

/** Still allowed in an archived space: looking, and un-archiving. */
const ARCHIVE_SAFE = new Set<string>(["space.view", "space.administer"]);

export function installPagesAccess(
  permissions: Permissions,
  db: Kysely<PagesDb>,
): PagesAccess {
  permissions.define("space.create", "global");
  for (const key of SPACE_PERMISSIONS) permissions.define(key, "space");

  const isAdmin = (user: AuthUser | null) =>
    user ? permissions.can(user, "system.admin") : Promise.resolve(false);

  /** Does one grant row name this user? Customers only ever through their own name. */
  function matches(
    g: { grantee_type: string; grantee_id: string | null },
    user: AuthUser | null,
    groupIds: Set<string>,
  ) {
    switch (g.grantee_type) {
      case "anyone":
        return user?.kind !== "customer";
      case "logged_in":
        return user !== null && user.kind !== "customer";
      case "user":
        return user !== null && g.grantee_id === user.id;
      case "group":
        return g.grantee_id !== null && groupIds.has(g.grantee_id);
      default:
        return false;
    }
  }

  /** The page and its ancestors, nearest first. */
  async function lineage(
    pageId: string,
  ): Promise<{ id: string; space_id: string }[]> {
    const out: { id: string; space_id: string }[] = [];
    let id: string | null = pageId;
    // A loop in the tree would be a bug elsewhere; the bound keeps it from hanging here.
    for (let depth = 0; id && depth < 100; depth++) {
      const row:
        { id: string; space_id: string; parent_id: string | null } | undefined =
        await db
          .selectFrom("pages_page")
          .select(["id", "space_id", "parent_id"])
          .where("id", "=", id)
          .executeTakeFirst();
      if (!row) break;
      out.push(row);
      id = row.parent_id;
    }
    return out;
  }

  permissions.registerScope("space", async (user, permission, raw) => {
    const target = raw as SpaceTarget | undefined;
    if (!target?.spaceId)
      throw new Error(`Permission "${permission}" needs a space target`);
    const space = await db
      .selectFrom("pages_space")
      .select(["id", "archived"])
      .where("id", "=", target.spaceId)
      .executeTakeFirst();
    if (!space) return false;
    if (space.archived && !ARCHIVE_SAFE.has(permission)) return false;

    const groupIds = new Set(user ? await permissions.groupIds(user.id) : []);
    const grants = await db
      .selectFrom("pages_space_permission")
      .select(["grantee_type", "grantee_id"])
      .where("space_id", "=", space.id)
      .where("permission", "=", permission)
      .execute();
    if (!grants.some((g) => matches(g, user, groupIds))) return false;
    if (!target.pageId) return true;

    const pages = await lineage(target.pageId);
    // A page of another space is not this space's business.
    if (pages[0]?.space_id !== space.id) return false;
    const restrictions = await db
      .selectFrom("pages_page_restriction")
      .select(["page_id", "kind", "grantee_type", "grantee_id"])
      .where(
        "page_id",
        "in",
        pages.map((p) => p.id),
      )
      .execute();
    // Every restricted page on the way down must let the user see it…
    for (const p of pages) {
      const view = restrictions.filter(
        (r) => r.page_id === p.id && r.kind === "view",
      );
      if (view.length && !view.some((r) => matches(r, user, groupIds)))
        return false;
    }
    // …and changing the page itself needs its own edit restriction, if it has one.
    if (permission === "space.edit" || permission === "space.delete") {
      const edit = restrictions.filter(
        (r) => r.page_id === target.pageId && r.kind === "edit",
      );
      if (edit.length && !edit.some((r) => matches(r, user, groupIds)))
        return false;
    }
    return true;
  });

  return {
    can: (user, permission, target) =>
      permissions.can(user, permission, target),
    require: (user, permission, target) =>
      permissions.require(user, permission, target),

    async visibleSpaceIds(user) {
      const spaces = await db.selectFrom("pages_space").select("id").execute();
      if (await isAdmin(user)) return spaces.map((s) => s.id);
      const groupIds = new Set(user ? await permissions.groupIds(user.id) : []);
      const grants = await db
        .selectFrom("pages_space_permission")
        .select(["space_id", "grantee_type", "grantee_id"])
        .where("permission", "=", "space.view")
        .execute();
      const visible = new Set(
        grants.filter((g) => matches(g, user, groupIds)).map((g) => g.space_id),
      );
      return spaces.map((s) => s.id).filter((id) => visible.has(id));
    },

    async hiddenPageIds(user, spaceIds) {
      const hidden = new Set<string>();
      if (!spaceIds.length || (await isAdmin(user))) return hidden;
      const groupIds = new Set(user ? await permissions.groupIds(user.id) : []);
      const restrictions = await db
        .selectFrom("pages_page_restriction as r")
        .innerJoin("pages_page as p", "p.id", "r.page_id")
        .select(["r.page_id", "r.grantee_type", "r.grantee_id"])
        .where("r.kind", "=", "view")
        .where("p.space_id", "in", spaceIds)
        .execute();
      const roots = new Set<string>();
      for (const id of new Set(restrictions.map((r) => r.page_id)))
        if (
          !restrictions.some(
            (r) => r.page_id === id && matches(r, user, groupIds),
          )
        )
          roots.add(id);
      if (!roots.size) return hidden;
      // Everything below a hidden page is hidden too.
      const pages = await db
        .selectFrom("pages_page")
        .select(["id", "parent_id"])
        .where("space_id", "in", spaceIds)
        .execute();
      const children = new Map<string, string[]>();
      for (const p of pages)
        if (p.parent_id)
          children.set(p.parent_id, [
            ...(children.get(p.parent_id) ?? []),
            p.id,
          ]);
      const stack = [...roots];
      while (stack.length) {
        const id = stack.pop()!;
        if (hidden.has(id)) continue;
        hidden.add(id);
        stack.push(...(children.get(id) ?? []));
      }
      return hidden;
    },
  };
}
