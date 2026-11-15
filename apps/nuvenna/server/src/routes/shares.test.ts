import { grantGlobal, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PagesDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<PagesDb>("public links", (t) => {
  let app: TestApp;
  let pageId: string;
  let secretId: string;
  const open = (token: string) => app.call("POST", "/shared", null, { token });
  const tokenOf = (url: string) => url.split("#")[1]!;

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
    await app.db
      .insertInto("pages_space_permission")
      .values({
        id: "be",
        space_id: space.id,
        permission: "space.edit",
        grantee_type: "user",
        grantee_id: app.ids.bert!,
      })
      .execute();
    secretId = (
      await app.call("POST", "/spaces/DOC/pages", "anna", {
        title: "Geheim",
        parentId: space.homePageId,
      })
    ).json().id;
    pageId = (
      await app.call("POST", "/spaces/DOC/pages", "anna", {
        title: "Anleitung",
        parentId: space.homePageId,
      })
    ).json().id;
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Öffentlich" }] },
        { type: "pageInclude", attrs: { pageId: secretId } },
        { type: "childPages" },
        { type: "image", attrs: { src: "/core/attachments/x", alt: "Bild" } },
        {
          type: "blockquote",
          content: [{ type: "pageInclude", attrs: { pageId: secretId } }],
        },
      ],
    };
    await app.db
      .updateTable("pages_page")
      .set({ content_json: JSON.stringify(doc) })
      .where("id", "=", pageId)
      .execute();
  }, 180_000);
  afterAll(() => app?.close());

  it("shows the shared page to anyone with the link, without blocks that need rights", async () => {
    const res = await app.call("POST", `/pages/${pageId}/shares`, "anna", {});
    expect(res.statusCode).toBe(201);
    const { url, id } = res.json();
    expect(url).toMatch(/^http:\/\/localhost\/nuvenna\/share#[\w-]{40,}$/);
    // Only the hash is stored.
    const stored = await app.db
      .selectFrom("pages_public_share")
      .select("token_hash")
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toContain(tokenOf(url));

    const shown = await open(tokenOf(url));
    expect(shown.statusCode).toBe(200);
    expect(shown.json().title).toBe("Anleitung");
    expect(shown.json().content).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Öffentlich" }] },
        { type: "blockquote", content: [] },
      ],
    });
    expect((await open("x".repeat(43))).statusCode).toBe(404);

    // Revoked links stop working.
    await app.call("DELETE", `/pages/${pageId}/shares/${id}`, "anna");
    expect((await open(tokenOf(url))).statusCode).toBe(404);
  });

  it("ends at the expiry date and with the page in the trash", async () => {
    expect(
      (
        await app.call("POST", `/pages/${pageId}/shares`, "anna", {
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        })
      ).statusCode,
    ).toBe(400);
    const { url } = (
      await app.call("POST", `/pages/${pageId}/shares`, "anna", {
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
    ).json();
    expect((await open(tokenOf(url))).statusCode).toBe(200);
    await app.db
      .updateTable("pages_public_share")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();
    expect((await open(tokenOf(url))).statusCode).toBe(404);

    const other = (
      await app.call("POST", `/pages/${secretId}/shares`, "anna", {})
    ).json().url;
    await app.call("DELETE", `/pages/${secretId}`, "anna");
    expect((await open(tokenOf(other))).statusCode).toBe(404);
  });

  it("lets only space administrators share", async () => {
    expect(
      (await app.call("POST", `/pages/${pageId}/shares`, "bert", {}))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.call("GET", `/pages/${pageId}/shares`, "gast")).statusCode,
    ).toBe(403);
    expect(
      (await app.call("GET", `/pages/${pageId}/shares`, "anna")).json(),
    ).toHaveLength(1);
  });

  it("slows down guessing", async () => {
    const codes = new Set<number>();
    for (let i = 0; i < 65; i++)
      codes.add((await open("y".repeat(43))).statusCode);
    expect([...codes].sort()).toEqual([404, 429]);
  });
});
