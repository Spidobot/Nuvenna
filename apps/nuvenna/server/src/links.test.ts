import { grantGlobal, sanitizeDoc, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PagesDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

describeEachDb<PagesDb>("ticket links", (t) => {
  let app: TestApp;
  const core = () => app.db as unknown as Kysely<CoreDb>;
  const drain = async () => {
    while ((await app.running.queue.runDue()) > 0);
  };
  const links = async (pageId: string) =>
    (
      await core()
        .selectFrom("core_link")
        .select("to_id")
        .where("from_type", "=", "page")
        .where("from_id", "=", pageId)
        .where("to_type", "=", "issue")
        .orderBy("to_id")
        .execute()
    ).map((l) => l.to_id);

  /** Runs due jobs until the links are as expected. On MariaDB times have
   *  whole seconds, so a job can become due a moment after it was queued. */
  const settled = (pageId: string, expected: string[]) =>
    expect
      .poll(
        async () => {
          await drain();
          return links(pageId);
        },
        { timeout: 10_000, interval: 300 },
      )
      .toEqual(expected);

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("anna");
    await grantGlobal(core(), "space.create", "user", app.ids.anna!);
    await app.call("POST", "/spaces", "anna", { key: "DOC", name: "Doku" });
  }, 180_000);
  afterAll(() => app?.close());

  it("keeps core_link in step with the ticket blocks of a page", async () => {
    // A template carries ticket blocks into the new page.
    const tpl = (
      await app.call("POST", "/spaces/DOC/pages", "anna", {
        title: "Vorlage",
        kind: "template",
      })
    ).json().id;
    await app.db
      .updateTable("pages_page")
      .set({
        content_json: JSON.stringify({
          type: "doc",
          content: [
            { type: "issue", attrs: { key: "IT-42" } },
            {
              type: "blockquote",
              content: [{ type: "issue", attrs: { key: "OPS-7" } }],
            },
            { type: "issue", attrs: { key: "IT-42" } },
          ],
        }),
      })
      .where("id", "=", tpl)
      .execute();
    const page = (
      await app.call("POST", "/spaces/DOC/pages", "anna", {
        title: "Plan",
        templateId: tpl,
      })
    ).json().id;
    await settled(page, ["IT-42", "OPS-7"]);
    // A ticket that links to the page counts too.
    await core()
      .insertInto("core_link")
      .values({
        from_type: "issue",
        from_id: "WEB-3",
        to_type: "page",
        to_id: page,
        kind: "page",
        created_at: new Date(),
      })
      .execute();
    expect(
      (await app.call("GET", `/pages/${page}/issues`, "anna")).json(),
    ).toEqual({ keys: ["IT-42", "OPS-7", "WEB-3"] });

    // An edit that drops one block drops its link.
    await app.db
      .updateTable("pages_page")
      .set({
        content_json: JSON.stringify({
          type: "doc",
          content: [{ type: "issue", attrs: { key: "OPS-7" } }],
        }),
      })
      .where("id", "=", page)
      .execute();
    await app.running.queue.emit(core(), {
      type: "page.updated",
      actorId: app.ids.anna!,
      entityType: "page",
      entityId: page,
    });
    await settled(page, ["OPS-7"]);

    // Gone for good: no links left.
    await app.call("DELETE", `/pages/${page}`, "anna");
    await app.call("DELETE", `/pages/${page}/purge`, "anna");
    await settled(page, []);
  });

  it("makes a page for a ticket from given content, checked like any other", async () => {
    const res = await app.call("POST", "/spaces/DOC/pages", "anna", {
      title: "IT-9 Drucker",
      content: {
        type: "doc",
        content: [{ type: "issue", attrs: { key: "IT-9" } }],
      },
    });
    expect(res.statusCode).toBe(201);
    await settled(res.json().id, ["IT-9"]);
    expect(
      (
        await app.call("POST", "/spaces/DOC/pages", "anna", {
          title: "Böse",
          content: { type: "doc", content: [{ type: "script" }] },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("only accepts real ticket keys", () => {
    const doc = sanitizeDoc({
      type: "doc",
      content: [
        { type: "issue", attrs: { key: "IT-42" } },
        { type: "issue", attrs: { key: "<script>" } },
        { type: "issue", attrs: { key: "it-1" } },
      ],
    });
    expect(doc.content!.map((n) => n.attrs!.key)).toEqual(["IT-42", "", ""]);
  });
});
