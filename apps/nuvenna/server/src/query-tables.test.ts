import { grantGlobal, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PagesDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

describeEachDb<PagesDb>("pages in the query engine", (t) => {
  let app: TestApp;
  let secret: string;
  const run = async (who: string, sql: string) =>
    app.call("POST", "/core/query/run", who, { sql });

  beforeAll(async () => {
    app = await startTestApp(t.url, { queryRole: true });
    for (const name of ["anna", "gast"]) await app.addUser(name);
    const core = app.db as unknown as Kysely<CoreDb>;
    await grantGlobal(core, "space.create", "user", app.ids.anna!);
    for (const who of ["anna", "gast"])
      await grantGlobal(core, "query.sql", "user", app.ids[who]!);
    const space = (
      await app.call("POST", "/spaces", "anna", { key: "DOC", name: "Doku" })
    ).json();
    const open = (
      await app.call("POST", "/spaces/DOC/pages", "anna", {
        title: "Offen",
        parentId: space.homePageId,
      })
    ).json().id;
    secret = (
      await app.call("POST", "/spaces/DOC/pages", "anna", {
        title: "Geheim",
        parentId: space.homePageId,
      })
    ).json().id;
    const child = (
      await app.call("POST", "/spaces/DOC/pages", "anna", {
        title: "Darunter",
        parentId: secret,
      })
    ).json().id;
    await app.db
      .insertInto("pages_page_restriction")
      .values({
        id: "r",
        page_id: secret,
        kind: "view",
        grantee_type: "user",
        grantee_id: app.ids.anna!,
      })
      .execute();
    await app.db
      .insertInto("pages_page_version")
      .values(
        [open, secret, child].map((page_id, i) => ({
          id: `v${i}`,
          page_id,
          number: 1,
          title: "v",
          content_json: "{}",
          author_id: app.ids.anna!,
          message: null,
          created_at: new Date(),
        })),
      )
      .execute();
    await core
      .insertInto("core_link")
      .values(
        [open, child].map((from_id) => ({
          from_type: "page",
          from_id,
          to_type: "issue",
          to_id: "IT-1",
          kind: "mentions",
          created_at: new Date(),
        })),
      )
      .execute();
  }, 180_000);
  afterAll(() => app?.close());

  it("shows each reader only the pages they may see, below restrictions too", async () => {
    const titles = async (who: string) =>
      (
        await run(
          who,
          "select title from pages where kind = 'page' order by title",
        )
      )
        .json()
        .rows.map((r: { title: string }) => r.title);
    expect(await titles("anna")).toEqual([
      "Darunter",
      "Doku",
      "Geheim",
      "Offen",
    ]);
    expect(await titles("gast")).toEqual(["Doku", "Offen"]);
  });

  it("filters versions and links through the visible pages", async () => {
    const count = async (who: string, table: string) =>
      Number(
        Object.values(
          (await run(who, `select count(*) as n from ${table}`)).json().rows[0],
        )[0],
      );
    expect(await count("anna", "page_versions")).toBe(3);
    expect(await count("gast", "page_versions")).toBe(1);
    expect(await count("anna", "links")).toBe(2);
    expect(await count("gast", "links")).toBe(1);
  });

  it("keeps base tables and stored JSON out of reach", async () => {
    expect((await run("gast", "select * from pages_page")).statusCode).toBe(
      400,
    );
    expect(
      (await run("gast", "select content_json from pages")).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await run(
          "gast",
          `select title from pages where id = '${secret}' union select title from page_versions`,
        )
      ).json().rows,
    ).toEqual([{ title: "v" }]);
  });
});
