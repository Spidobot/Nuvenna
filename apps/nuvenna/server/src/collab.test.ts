import { grantGlobal, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookie } from "./collab.js";
import * as Y from "yjs";
import type { PagesDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

const paragraph = (y: Y.Doc, text: string) => {
  const p = new Y.XmlElement("paragraph");
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  y.getXmlFragment("default").push([p]);
};

/** Polls until `check` holds or the time is up. */
async function until(check: () => Promise<boolean> | boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out");
}

describeEachDb<PagesDb>("collaborative editing", (t) => {
  let app: TestApp;
  let pageId: string;
  const providers: HocuspocusProvider[] = [];

  const connect = (who: string) => {
    const document = new Y.Doc();
    const state = { synced: false, failed: false, closed: false };
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${app.port}/nuvenna/api/collab`,
      name: pageId,
      token: app.token(who),
      document,
      onSynced: () => (state.synced = true),
      onAuthenticationFailed: () => (state.failed = true),
      onClose: () => (state.closed = true),
    });
    providers.push(provider);
    return { provider, document, state };
  };
  const stored = async () =>
    await app.db
      .selectFrom("pages_page")
      .select(["content_text", "version"])
      .where("id", "=", pageId)
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["anna", "bert", "gast", "fremd"])
      await app.addUser(name);
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
        id: "bert-edit",
        space_id: space.id,
        permission: "space.edit",
        grantee_type: "user",
        grantee_id: app.ids.bert!,
      })
      .execute();
    // fremd sees nothing: the space is only for signed-in users, and fremd is shut out by a restriction.
    pageId = (
      await app.call("POST", "/spaces/DOC/pages", "anna", {
        title: "Gemeinsam",
        parentId: space.homePageId,
      })
    ).json().id;
    await app.db
      .insertInto("pages_page_restriction")
      .values([
        {
          id: "r-anna",
          page_id: pageId,
          kind: "view",
          grantee_type: "user",
          grantee_id: app.ids.anna!,
        },
        {
          id: "r-bert",
          page_id: pageId,
          kind: "view",
          grantee_type: "user",
          grantee_id: app.ids.bert!,
        },
        {
          id: "r-gast",
          page_id: pageId,
          kind: "view",
          grantee_type: "user",
          grantee_id: app.ids.gast!,
        },
      ])
      .execute();
  }, 180_000);
  afterAll(async () => {
    for (const p of providers) p.destroy();
    await app?.close();
  });

  it("merges edits of two writers and keeps both after a disconnect", async () => {
    const anna = connect("anna");
    const bert = connect("bert");
    await until(() => anna.state.synced && bert.state.synced);
    paragraph(anna.document, "Anna schreibt");
    paragraph(bert.document, "Bert schreibt");
    await until(async () => {
      const s = await stored();
      return (
        s.content_text.includes("Anna schreibt") &&
        s.content_text.includes("Bert schreibt")
      );
    });
    // Bert drops out, Anna goes on; Bert comes back and sees everything.
    bert.provider.destroy();
    paragraph(anna.document, "Anna allein");
    const again = connect("bert");
    await until(() => again.state.synced);
    await until(() =>
      JSON.stringify(
        again.document.getXmlFragment("default").toJSON(),
      ).includes("Anna allein"),
    );
    await until(async () =>
      (await stored()).content_text.includes("Anna allein"),
    );
    expect((await stored()).version).toBeGreaterThan(1);
  });

  it("lets readers watch but not write, and keeps strangers out", async () => {
    const gast = connect("gast");
    await until(() => gast.state.synced);
    paragraph(gast.document, "Gast kritzelt");
    await new Promise((r) => setTimeout(r, 3000));
    expect((await stored()).content_text).not.toContain("Gast kritzelt");

    const fremd = connect("fremd");
    await until(() => fremd.state.failed);
    expect(fremd.state.synced).toBe(false);
  });

  it("disconnects whoever loses the right to read", async () => {
    const bert = connect("bert");
    await until(() => bert.state.synced);
    await app.db
      .deleteFrom("pages_page_restriction")
      .where("id", "=", "r-bert")
      .execute();
    await app.running.queue.emit(app.db as unknown as Kysely<CoreDb>, {
      type: "page.restricted",
      actorId: app.ids.anna!,
      entityType: "page",
      entityId: pageId,
    });
    while ((await app.running.queue.runDue()) > 0);
    await until(() => bert.state.closed);
  });
});

describe("the session cookie of a socket", () => {
  const headers = (origin?: string) =>
    new Headers({
      cookie: "a=1; tvn_session=abc",
      ...(origin && { origin }),
    });
  it("counts only on sockets opened by our own pages", () => {
    expect(
      sessionCookie(headers("https://w.example"), "https://w.example"),
    ).toBe("abc");
    expect(
      sessionCookie(headers("https://evil.example"), "https://w.example"),
    ).toBeUndefined();
    expect(sessionCookie(headers(), "https://w.example")).toBeUndefined();
  });
});
