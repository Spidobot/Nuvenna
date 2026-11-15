import { grantGlobal, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as Y from "yjs";
import type { PagesDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";
import { diffLines } from "./versions.js";

it("compares blocks", () => {
  expect(diffLines(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
    { change: "same", text: "a" },
    { change: "removed", text: "b" },
    { change: "added", text: "x" },
    { change: "same", text: "c" },
    { change: "added", text: "d" },
  ]);
});

async function until(check: () => Promise<boolean> | boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out");
}
const paragraph = (y: Y.Doc, text: string) => {
  const p = new Y.XmlElement("paragraph");
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  y.getXmlFragment("default").push([p]);
};

describeEachDb<PagesDb>("page versions", (t) => {
  let app: TestApp;
  let pageId: string;
  const providers: HocuspocusProvider[] = [];
  const connect = () => {
    const document = new Y.Doc();
    const state = { synced: false };
    providers.push(
      new HocuspocusProvider({
        url: `ws://127.0.0.1:${app.port}/nuvenna/api/collab`,
        name: pageId,
        token: app.token("anna"),
        document,
        onSynced: () => (state.synced = true),
      }),
    );
    return { provider: providers.at(-1)!, document, state };
  };
  const versions = async () =>
    (await app.call("GET", `/pages/${pageId}/versions`, "anna")).json() as {
      number: number;
      message: string | null;
    }[];
  const text = async () =>
    (
      await app.db
        .selectFrom("pages_page")
        .select("content_text")
        .where("id", "=", pageId)
        .executeTakeFirstOrThrow()
    ).content_text;

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
    const space = (
      await app.call("POST", "/spaces", "anna", { key: "DOC", name: "Doku" })
    ).json();
    pageId = (
      await app.call("POST", "/spaces/DOC/pages", "anna", {
        title: "Notizen",
        parentId: space.homePageId,
      })
    ).json().id;
  }, 180_000);
  afterAll(async () => {
    for (const p of providers) p.destroy();
    await app?.close();
  });

  it("takes a version when the last editor leaves", async () => {
    const a = connect();
    await until(() => a.state.synced);
    paragraph(a.document, "eins");
    await until(async () => (await text()).includes("eins"));
    a.provider.destroy();
    await until(async () => (await versions()).length === 1);
  });

  it("takes named versions and compares them", async () => {
    const a = connect();
    await until(() => a.state.synced);
    paragraph(a.document, "zwei");
    await until(async () => (await text()).includes("zwei"));
    expect(
      (
        await app.call("POST", `/pages/${pageId}/versions`, "gast", {
          message: "x",
        })
      ).statusCode,
    ).toBe(403);
    const named = await app.call("POST", `/pages/${pageId}/versions`, "anna", {
      message: "Stand für das Meeting",
    });
    expect(named.json()).toEqual({ number: 2 });
    expect((await versions())[0]).toMatchObject({
      number: 2,
      message: "Stand für das Meeting",
    });
    const diff = (
      await app.call("GET", `/pages/${pageId}/compare?from=1&to=2`, "gast")
    ).json();
    expect(diff.blocks).toEqual([
      { change: "same", text: "eins" },
      { change: "added", text: "zwei" },
    ]);

    // Restoring version 1 arrives in the open editor as a change.
    expect(
      (await app.call("POST", `/pages/${pageId}/versions/1/restore`, "anna"))
        .statusCode,
    ).toBe(204);
    await until(
      () =>
        !JSON.stringify(a.document.getXmlFragment("default").toJSON()).includes(
          "zwei",
        ),
    );
    await until(async () => !(await text()).includes("zwei"));
    expect(await text()).toContain("eins");
    a.provider.destroy();
    // Leaving ends the session: the restored state becomes version 3.
    await until(async () => (await versions()).length === 3);
  });

  it("ends a session after ten quiet minutes", async () => {
    const before = (await versions()).length;
    await app.db
      .updateTable("pages_page")
      .set({
        content_json: JSON.stringify({
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "drei" }] },
          ],
        }),
        updated_at: new Date(Date.now() - 11 * 60_000),
      })
      .where("id", "=", pageId)
      .execute();
    const now = new Date();
    await app.db
      .insertInto("core_job")
      .values({
        id: "every:pages-version-sessions",
        type: "every:pages-version-sessions",
        payload_json: "null",
        run_at: now,
        state: "pending",
        attempts: 0,
        locked_by: null,
        locked_at: null,
        last_error: null,
        created_at: now,
      })
      .execute();
    await app.running.queue.runDue(new Date(Date.now() + 1000));
    expect((await versions()).length).toBe(before + 1);
  });
});
