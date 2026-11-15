import { grantGlobal, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PagesDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<PagesDb>("spaces and the page tree", (t) => {
  let app: TestApp;
  const ids: Record<string, string> = {};

  const tree = async (as = "mira", key = "DOC") =>
    (await app.call("GET", `/spaces/${key}/tree`, as)).json() as {
      id: string;
      parentId: string | null;
      position: number;
      title: string;
    }[];
  const titles = async (parentId: string | null, key = "DOC") =>
    (await tree("mira", key))
      .filter((p) => p.parentId === parentId)
      .sort((a, b) => a.position - b.position)
      .map((p) => p.title);
  const add = async (title: string, parentId: string | null = null) => {
    const made = (
      await app.call("POST", "/spaces/DOC/pages", "mira", { title, parentId })
    ).json();
    ids[title] = made.id;
    return made;
  };

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "gast"]) await app.addUser(name);
    await grantGlobal(
      app.db as unknown as Kysely<CoreDb>,
      "space.create",
      "user",
      app.ids.mira!,
    );
  }, 180_000);
  afterAll(() => app?.close());

  it("creates spaces with a home page for those allowed to", async () => {
    expect(
      (await app.call("POST", "/spaces", "gast", { key: "DOC", name: "Doku" }))
        .statusCode,
    ).toBe(403);
    const made = await app.call("POST", "/spaces", "mira", {
      key: "doc",
      name: "Doku",
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      key: "DOC",
      name: "Doku",
      rights: expect.arrayContaining(["space.administer"]),
    });
    expect(
      (await app.call("POST", "/spaces", "mira", { key: "DOC", name: "x" }))
        .statusCode,
    ).toBe(409);
    ids.home = made.json().homePageId;
    // Everyone signed in reads, but only the creator writes.
    expect(
      (await app.call("GET", "/spaces/DOC", "gast")).json().rights.sort(),
    ).toEqual(["space.comment", "space.view"]);
    expect(
      (await app.call("POST", "/spaces/DOC/pages", "gast", { title: "x" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.call("GET", "/spaces", "gast"))
        .json()
        .map((s: { key: string }) => s.key),
    ).toEqual(["DOC"]);
  });

  it("builds, reorders and moves pages in the tree", async () => {
    for (const title of ["A", "B", "C"]) await add(title, ids.home!);
    await add("A1", ids.A!);
    expect(await titles(ids.home!)).toEqual(["A", "B", "C"]);
    // C to the front.
    await app.call("POST", `/pages/${ids.C}/move`, "mira", {
      parentId: ids.home,
      position: 0,
    });
    expect(await titles(ids.home!)).toEqual(["C", "A", "B"]);
    // A (with A1) below B.
    await app.call("POST", `/pages/${ids.A}/move`, "mira", {
      parentId: ids.B,
      position: null,
    });
    expect(await titles(ids.home!)).toEqual(["C", "B"]);
    expect(await titles(ids.B!)).toEqual(["A"]);
    expect(await titles(ids.A!)).toEqual(["A1"]);
    // Not below itself.
    expect(
      (
        await app.call("POST", `/pages/${ids.A}/move`, "mira", {
          parentId: ids.A1,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("POST", `/pages/${ids.A}/move`, "gast", {
          parentId: null,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("copies a page with its sub-pages", async () => {
    const copy = (
      await app.call("POST", `/pages/${ids.B}/copy`, "mira", {
        parentId: ids.home,
        title: "B (Kopie)",
      })
    ).json();
    expect(await titles(ids.home!)).toEqual(["C", "B", "B (Kopie)"]);
    expect(await titles(copy.id)).toEqual(["A"]);
    const flat = await app.call("POST", `/pages/${ids.B}/copy`, "mira", {
      parentId: ids.home,
      withChildren: false,
      title: "B flach",
    });
    expect(await titles(flat.json().id)).toEqual([]);
  });

  it("puts pages into the trash with what is below and brings them back", async () => {
    expect(
      (await app.call("DELETE", `/pages/${ids.home}`, "mira")).statusCode,
    ).toBe(409);
    expect(
      (await app.call("DELETE", `/pages/${ids.B}`, "gast")).statusCode,
    ).toBe(403);
    expect(
      (await app.call("DELETE", `/pages/${ids.B}`, "mira")).statusCode,
    ).toBe(204);
    expect(await titles(ids.home!)).toEqual(["C", "B (Kopie)", "B flach"]);
    expect((await tree()).some((p) => p.id === ids.A1)).toBe(false);
    const trash = (await app.call("GET", "/spaces/DOC/trash", "mira")).json();
    expect(trash.map((p: { title: string }) => p.title)).toEqual(["B"]);
    expect(
      (await app.call("GET", `/pages/${ids.A1}`, "mira")).json().status,
    ).toBe("trashed");

    expect(
      (await app.call("POST", `/pages/${ids.B}/restore`, "mira")).statusCode,
    ).toBe(204);
    expect(await titles(ids.home!)).toEqual(["C", "B (Kopie)", "B flach", "B"]);
    expect(await titles(ids.A!)).toEqual(["A1"]);

    await app.call("DELETE", `/pages/${ids.C}`, "mira");
    expect(
      (await app.call("DELETE", `/pages/${ids.C}/purge`, "mira")).statusCode,
    ).toBe(204);
    expect((await app.call("GET", `/pages/${ids.C}`, "mira")).statusCode).toBe(
      404,
    );
  });

  it("keeps restricted pages out of the tree", async () => {
    await app.db
      .insertInto("pages_page_restriction")
      .values({
        id: "r1",
        page_id: ids.B!,
        kind: "view",
        grantee_type: "user",
        grantee_id: app.ids.mira!,
      })
      .execute();
    expect((await tree("gast")).map((p) => p.id)).not.toContain(ids.A1);
    expect((await tree("gast")).map((p) => p.id)).not.toContain(ids.B);
    expect((await app.call("GET", `/pages/${ids.A}`, "gast")).statusCode).toBe(
      404,
    );
    expect((await tree("mira")).map((p) => p.id)).toContain(ids.A1);
  });
});
