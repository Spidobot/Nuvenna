import { grantGlobal, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PagesDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<PagesDb>("space administration", (t) => {
  let app: TestApp;
  let pageId: string;
  const events = async (type: string) =>
    (
      await (app.db as unknown as Kysely<CoreDb>)
        .selectFrom("core_event")
        .select("id")
        .where("type", "=", type)
        .execute()
    ).length;

  beforeAll(async () => {
    app = await startTestApp(t.url);
    for (const name of ["anna", "bert", "gast"]) await app.addUser(name);
    await grantGlobal(
      app.db as unknown as Kysely<CoreDb>,
      "space.create",
      "user",
      app.ids.anna!,
    );
    const space = (
      await app.call("POST", "/spaces", "anna", { key: "DOC", name: "Doku" })
    ).json();
    pageId = (
      await app.call("POST", "/spaces/DOC/pages", "anna", {
        title: "Plan",
        parentId: space.homePageId,
      })
    ).json().id;
  }, 180_000);
  afterAll(() => app?.close());

  it("grants and revokes space rights, but keeps one administrator", async () => {
    expect(
      (await app.call("GET", "/spaces/DOC/permissions", "bert")).statusCode,
    ).toBe(403);
    const before = await events("space.permissions_changed");
    expect(
      (
        await app.call("POST", "/spaces/DOC/permissions", "anna", {
          permission: "space.edit",
          granteeType: "user",
          granteeId: app.ids.bert,
        })
      ).statusCode,
    ).toBe(204);
    expect(await events("space.permissions_changed")).toBe(before + 1);
    const list = (
      await app.call("GET", "/spaces/DOC/permissions", "anna")
    ).json() as {
      id: string;
      permission: string;
      granteeType: string;
      name: string | null;
    }[];
    expect(list).toContainEqual(
      expect.objectContaining({ permission: "space.edit", name: "bert" }),
    );
    // bert may now create pages.
    expect(
      (
        await app.call("POST", "/spaces/DOC/pages", "bert", {
          title: "Von Bert",
        })
      ).statusCode,
    ).toBe(201);

    const admin = list.find((g) => g.permission === "space.administer")!;
    expect(
      (await app.call("DELETE", `/spaces/DOC/permissions/${admin.id}`, "anna"))
        .statusCode,
    ).toBe(409);
    const edit = list.find(
      (g) => g.permission === "space.edit" && g.name === "bert",
    )!;
    await app.call("DELETE", `/spaces/DOC/permissions/${edit.id}`, "anna");
    expect(
      (
        await app.call("POST", "/spaces/DOC/pages", "bert", {
          title: "Noch einmal",
        })
      ).statusCode,
    ).toBe(403);
  });

  it("restricts a page and never locks out the one restricting it", async () => {
    await app.call("POST", "/spaces/DOC/permissions", "anna", {
      permission: "space.edit",
      granteeType: "user",
      granteeId: app.ids.bert,
    });
    const res = await app.call("PUT", `/pages/${pageId}/restrictions`, "bert", {
      view: [{ type: "user", id: app.ids.anna }],
      edit: [],
    });
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .view.map((x: { name: string }) => x.name)
        .sort(),
    ).toEqual(["anna", "bert"]);
    expect(await events("page.restricted")).toBe(1);
    expect((await app.call("GET", `/pages/${pageId}`, "gast")).statusCode).toBe(
      404,
    );
    expect((await app.call("GET", `/pages/${pageId}`, "bert")).statusCode).toBe(
      200,
    );
    // Readers cannot change restrictions.
    expect(
      (
        await app.call("PUT", `/pages/${pageId}/restrictions`, "gast", {
          view: [],
          edit: [],
        })
      ).statusCode,
    ).toBe(404);
    await app.call("PUT", `/pages/${pageId}/restrictions`, "anna", {
      view: [],
      edit: [],
    });
    expect((await app.call("GET", `/pages/${pageId}`, "gast")).statusCode).toBe(
      200,
    );
  });

  it("sets the home page, archives, and tells everyone", async () => {
    const before = await events("space.updated");
    await app.call("PATCH", "/spaces/DOC", "anna", {
      homePageId: pageId,
      archived: true,
    });
    expect(await events("space.updated")).toBe(before + 1);
    const space = (await app.call("GET", "/spaces/DOC", "anna")).json();
    expect(space).toMatchObject({ homePageId: pageId, archived: true });
    // Archived: still readable, no longer writable, even for the admin.
    expect(
      (await app.call("POST", "/spaces/DOC/pages", "anna", { title: "X" }))
        .statusCode,
    ).toBe(403);
    expect((await app.call("GET", `/pages/${pageId}`, "gast")).statusCode).toBe(
      200,
    );
    await app.call("PATCH", "/spaces/DOC", "anna", { archived: false });
    expect(
      (await app.call("POST", "/spaces/DOC/pages", "anna", { title: "X" }))
        .statusCode,
    ).toBe(201);
  });
});
