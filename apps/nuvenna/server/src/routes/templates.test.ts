import { grantGlobal, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Kysely } from "kysely";
import * as Y from "yjs";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PagesDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<PagesDb>("templates", (t) => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("anna");
    await app.addUser("gast");
    await grantGlobal(
      app.db as unknown as Kysely<CoreDb>,
      "space.create",
      "user",
      app.ids.anna!,
    );
    await app.call("POST", "/spaces", "anna", { key: "DOC", name: "Doku" });
    await app.call("POST", "/spaces", "anna", { key: "ALT", name: "Alt" });
  }, 180_000);
  afterAll(() => app?.close());

  it("starts a page from a built-in template", async () => {
    const list = (
      await app.call("GET", "/spaces/DOC/templates", "anna")
    ).json();
    expect(list.map((x: { id: string }) => x.id)).toEqual([
      "builtin:meeting",
      "builtin:decision",
      "builtin:howto",
      "builtin:retro",
    ]);
    const page = (
      await app.call("POST", "/spaces/DOC/pages", "anna", {
        title: "Jour fixe",
        templateId: "builtin:meeting",
      })
    ).json();
    expect(JSON.stringify(page.content)).toMatch(/Tagesordnung|Agenda/);

    // A reader who reconnects with the same document must not get it twice,
    // even when the server let go of the page in between.
    const ydoc = new Y.Doc();
    const open = async () => {
      let synced = false;
      const provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${app.port}/nuvenna/api/collab`,
        name: page.id,
        token: app.token("anna"),
        document: ydoc,
        onSynced: () => (synced = true),
      });
      while (!synced) await new Promise((r) => setTimeout(r, 50));
      return provider;
    };
    (await open()).destroy();
    await new Promise((r) => setTimeout(r, 500));
    const again = await open();
    expect(ydoc.getXmlFragment("default").length).toBe(
      page.content.content.length,
    );
    again.destroy();
  });

  it("starts a page from a template of the same space only", async () => {
    const tpl = (
      await app.call("POST", "/spaces/DOC/pages", "anna", {
        title: "Release",
        kind: "template",
        templateId: "builtin:howto",
      })
    ).json();
    expect(
      (await app.call("GET", "/spaces/DOC/templates", "anna")).json().at(-1),
    ).toMatchObject({ id: tpl.id, title: "Release" });
    const page = (
      await app.call("POST", "/spaces/DOC/pages", "anna", {
        title: "Release 2.0",
        templateId: tpl.id,
      })
    ).json();
    expect(page.kind).toBe("page");
    expect(page.content).toEqual(tpl.content);
    expect(
      (
        await app.call("POST", "/spaces/ALT/pages", "anna", {
          title: "X",
          templateId: tpl.id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("POST", "/spaces/DOC/pages", "gast", {
          title: "X",
          templateId: "builtin:retro",
        })
      ).statusCode,
    ).toBe(403);
  });
});
