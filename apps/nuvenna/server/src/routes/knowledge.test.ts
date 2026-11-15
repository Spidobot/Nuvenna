import { grantGlobal, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PagesDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<PagesDb>("knowledge base for the portal", (t) => {
  let app: TestApp;
  let open: string;
  let secret: string;

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("anna");
    await app.addUser("kunde", { kind: "customer" });
    await grantGlobal(
      app.db as unknown as Kysely<CoreDb>,
      "space.create",
      "user",
      app.ids.anna!,
    );
    const space = (
      await app.call("POST", "/spaces", "anna", { key: "HILFE", name: "Hilfe" })
    ).json();
    const add = async (title: string, text: string) => {
      const id = (
        await app.call("POST", "/spaces/HILFE/pages", "anna", {
          title,
          parentId: space.homePageId,
          content: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text }] },
              { type: "pageInclude", attrs: { pageId: "x" } },
            ],
          },
        })
      ).json().id as string;
      return id;
    };
    open = await add(
      "Drucker druckt nicht",
      "Papierfach prüfen und neu starten.",
    );
    secret = await add("Drucker intern", "Admin-Passwort des Druckers ändern.");
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
  }, 180_000);
  afterAll(() => app?.close());

  it("offers nothing until the space is a knowledge base", async () => {
    expect(
      (await app.call("GET", "/kb/HILFE/search?q=drucker", "kunde")).statusCode,
    ).toBe(404);
    // Customers get nothing from Nuvenna otherwise.
    expect((await app.call("GET", "/spaces", "kunde")).json()).toEqual([]);
  });

  it("lets customers search and read unrestricted pages only", async () => {
    await app.call("PATCH", "/spaces/HILFE", "anna", { knowledgeBase: true });
    const hits = (
      await app.call("GET", "/kb/HILFE/search?q=drucker%20papierfach", "kunde")
    ).json();
    expect(hits.map((h: { title: string }) => h.title)).toEqual([
      "Drucker druckt nicht",
    ]);
    const page = (
      await app.call("GET", `/kb/HILFE/pages/${open}`, "kunde")
    ).json();
    expect(page.content.content.map((n: { type: string }) => n.type)).toEqual([
      "paragraph",
    ]);
    expect(
      (await app.call("GET", `/kb/HILFE/pages/${secret}`, "kunde")).statusCode,
    ).toBe(404);
    expect(
      (await app.call("GET", `/kb/HILFE/search?q=drucker`, null)).statusCode,
    ).toBe(401);
  });
});
