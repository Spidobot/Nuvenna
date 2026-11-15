import { grantGlobal, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PagesDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<PagesDb>("page search", (t) => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp(t.url);
    for (const name of ["anna", "gast"]) await app.addUser(name);
    await grantGlobal(
      app.db as unknown as Kysely<CoreDb>,
      "space.create",
      "user",
      app.ids.anna!,
    );
    const space = (
      await app.call("POST", "/spaces", "anna", { key: "DOC", name: "Doku" })
    ).json();
    const add = async (title: string, text: string) => {
      const id = (
        await app.call("POST", "/spaces/DOC/pages", "anna", {
          title,
          parentId: space.homePageId,
        })
      ).json().id as string;
      await app.db
        .updateTable("pages_page")
        .set({ content_text: text })
        .where("id", "=", id)
        .execute();
      return id;
    };
    await add("Drucker einrichten", "Treiber laden und installieren.");
    await add(
      "VPN",
      "Für den Drucker im Büro braucht es das VPN. 100% sicher.",
    );
    const secret = await add("Gehälter", "Drucker-Budget und Gehälter");
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

  const search = async (who: string, q: string) =>
    (
      await app.call("GET", `/search?q=${encodeURIComponent(q)}`, who)
    ).json() as { title: string; excerpt: string }[];

  it("finds title and text hits, title first, with an excerpt", async () => {
    const hits = await search("anna", "drucker");
    expect(hits[0]!.title).toBe("Drucker einrichten");
    expect(hits.map((h) => h.title).sort()).toEqual([
      "Drucker einrichten",
      "Gehälter",
      "VPN",
    ]);
    expect(hits.find((h) => h.title === "VPN")!.excerpt).toMatch(
      /Drucker im Büro/,
    );
  });

  it("leaves out what the reader may not see", async () => {
    expect(
      (await search("gast", "drucker")).map((h) => h.title).sort(),
    ).toEqual(["Drucker einrichten", "VPN"]);
  });

  it("treats wildcards as text", async () => {
    expect((await search("anna", "0%")).map((h) => h.title)).toEqual(["VPN"]);
    expect(await search("anna", "_n")).toEqual([]);
  });
});
