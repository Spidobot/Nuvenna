import {
  createPermissions,
  grantGlobal,
  migrateCore,
  SYSTEM_ADMIN,
  uuidv7,
  type AuthUser,
} from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import { beforeAll, expect, it } from "vitest";
import {
  installPagesAccess,
  type PagesAccess,
  type SpacePermission,
} from "./access.js";
import { migratePages } from "./db/migrations/index.js";
import type { PagesDb } from "./db/schema.js";

describeEachDb<PagesDb>("space permissions and page restrictions", (t) => {
  let access: PagesAccess;
  const users: Record<string, AuthUser> = {};

  const addUser = async (name: string, kind: AuthUser["kind"] = "internal") => {
    const now = new Date();
    const id = uuidv7();
    await t.db
      .insertInto("core_user")
      .values({
        id,
        email: `${name}@example.org`,
        display_name: name,
        password_hash: null,
        kind,
        active: true,
        locale: "de",
        timezone: "UTC",
        created_at: now,
        updated_at: now,
      })
      .execute();
    users[name] = {
      id,
      email: `${name}@example.org`,
      displayName: name,
      kind,
      locale: "de",
      timezone: "UTC",
    };
  };
  const grant = (
    space: string,
    permission: string,
    grantee_type: "group" | "user" | "anyone" | "logged_in",
    grantee_id: string | null = null,
  ) =>
    t.db
      .insertInto("pages_space_permission")
      .values({
        id: uuidv7(),
        space_id: space,
        permission,
        grantee_type,
        grantee_id,
      })
      .execute();
  const page = (id: string, space: string, parent: string | null) => {
    const now = new Date();
    return t.db
      .insertInto("pages_page")
      .values({
        id,
        space_id: space,
        parent_id: parent,
        position: 0,
        title: id,
        kind: "page",
        status: "current",
        version: 1,
        content_json: "{}",
        content_text: "",
        created_by: users.root!.id,
        created_at: now,
        updated_by: users.root!.id,
        updated_at: now,
        trashed_at: null,
      })
      .execute();
  };
  const restrict = (
    pageId: string,
    kind: "view" | "edit",
    type: "user" | "group",
    id: string,
  ) =>
    t.db
      .insertInto("pages_page_restriction")
      .values({
        id: uuidv7(),
        page_id: pageId,
        kind,
        grantee_type: type,
        grantee_id: id,
      })
      .execute();

  beforeAll(async () => {
    await migrateCore(t as never);
    await migratePages(t);
    access = installPagesAccess(createPermissions(t.db as never), t.db);
    for (const name of ["root", "anna", "bert", "gast", "kunde"])
      await addUser(name, name === "kunde" ? "customer" : "internal");
    await grantGlobal(t.db as never, SYSTEM_ADMIN, "user", users.root!.id);
    await t.db
      .insertInto("core_group")
      .values({ id: "hr", name: "HR", created_at: new Date() })
      .execute();
    await t.db
      .insertInto("core_group_member")
      .values({ group_id: "hr", user_id: users.anna!.id })
      .execute();
    const now = new Date();
    for (const [id, archived] of [
      ["team", false],
      ["alt", true],
      ["offen", false],
    ] as const)
      await t.db
        .insertInto("pages_space")
        .values({
          id,
          space_key: id.toUpperCase(),
          name: id,
          description: "",
          home_page_id: null,
          archived,
          created_at: now,
        })
        .execute();
    // team: everyone signed in reads, anna and bert write. offen: anyone reads. alt: archived.
    await grant("team", "space.view", "logged_in");
    for (const who of ["anna", "bert"])
      await grant("team", "space.edit", "user", users[who]!.id);
    await grant("team", "space.comment", "logged_in");
    await grant("offen", "space.view", "anyone");
    await grant("alt", "space.view", "logged_in");
    await grant("alt", "space.edit", "logged_in");
    // team: start ─ personal (view: HR only) ─ salaries
    //             └ handbook (edit: bert only)
    await page("start", "team", null);
    await page("personal", "team", "start");
    await page("salaries", "team", "personal");
    await page("handbook", "team", "start");
    await page("fremd", "offen", null);
    await restrict("personal", "view", "group", "hr");
    await restrict("handbook", "edit", "user", users.bert!.id);
  });

  it("decides every case from space rights and restrictions", async () => {
    const table: [
      string | null,
      SpacePermission,
      string,
      string | undefined,
      boolean,
    ][] = [
      ["gast", "space.view", "team", undefined, true],
      ["gast", "space.edit", "team", undefined, false],
      ["anna", "space.edit", "team", "start", true],
      [null, "space.view", "team", undefined, false], // anonymous is not "logged in"
      [null, "space.view", "offen", undefined, true], // but is "anyone"
      ["kunde", "space.view", "team", undefined, false], // customers do not count as signed in here
      ["kunde", "space.view", "offen", undefined, false], // nor as anyone
      // A view restriction hides the page and everything below.
      ["anna", "space.view", "team", "personal", true],
      ["anna", "space.view", "team", "salaries", true],
      ["bert", "space.view", "team", "personal", false],
      ["bert", "space.view", "team", "salaries", false],
      ["bert", "space.comment", "team", "salaries", false],
      // An edit restriction holds for the page only, not for viewing.
      ["anna", "space.view", "team", "handbook", true],
      ["anna", "space.edit", "team", "handbook", false],
      ["bert", "space.edit", "team", "handbook", true],
      // Pages of another space never pass through this one.
      ["anna", "space.view", "team", "fremd", false],
      // Archived spaces can be read, not changed.
      ["gast", "space.view", "alt", undefined, true],
      ["gast", "space.edit", "alt", undefined, false],
      // System administrators pass everything.
      ["root", "space.view", "team", "salaries", true],
      ["root", "space.edit", "alt", undefined, true],
    ];
    for (const [who, permission, spaceId, pageId, expected] of table)
      expect(
        await access.can(who ? users[who]! : null, permission, {
          spaceId,
          pageId,
        }),
        `${who} ${permission} ${spaceId}/${pageId}`,
      ).toBe(expected);
  });

  it("lists visible spaces and hidden pages for lists and queries", async () => {
    expect((await access.visibleSpaceIds(users.gast!)).sort()).toEqual([
      "alt",
      "offen",
      "team",
    ]);
    expect(await access.visibleSpaceIds(null)).toEqual(["offen"]);
    expect(await access.visibleSpaceIds(users.kunde!)).toEqual([]);
    expect(
      [...(await access.hiddenPageIds(users.bert!, ["team"]))].sort(),
    ).toEqual(["personal", "salaries"]);
    expect([...(await access.hiddenPageIds(users.anna!, ["team"]))]).toEqual(
      [],
    );
    expect([...(await access.hiddenPageIds(users.root!, ["team"]))]).toEqual(
      [],
    );
  });
});
