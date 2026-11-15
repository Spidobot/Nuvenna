import { grantGlobal, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PagesDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

const doc = (text: string, mention?: { id: string; label: string }) => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text },
        ...(mention ? [{ type: "mention", attrs: mention }] : []),
      ],
    },
  ],
});

describeEachDb<PagesDb>("page comments", (t) => {
  let app: TestApp;
  let pageId: string;

  beforeAll(async () => {
    app = await startTestApp(t.url);
    for (const name of ["anna", "bert", "fremd"]) await app.addUser(name);
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
    // fremd may not see the page.
    await app.db
      .insertInto("pages_page_restriction")
      .values([
        {
          id: "r1",
          page_id: pageId,
          kind: "view",
          grantee_type: "user",
          grantee_id: app.ids.anna!,
        },
        {
          id: "r2",
          page_id: pageId,
          kind: "view",
          grantee_type: "user",
          grantee_id: app.ids.bert!,
        },
      ])
      .execute();
  }, 180_000);
  afterAll(() => app?.close());

  it("keeps threads with replies, on the page or on a passage", async () => {
    const thread = await app.call("POST", `/pages/${pageId}/comments`, "bert", {
      body: doc("Stimmt das Datum? "),
      anchor: { quote: "am 3. Dezember" },
    });
    expect(thread.statusCode).toBe(201);
    expect(thread.json()).toMatchObject({
      anchor: { quote: "am 3. Dezember" },
      resolved: false,
      authorId: app.ids.bert,
    });
    const reply = await app.call("POST", `/pages/${pageId}/comments`, "anna", {
      body: doc("Ja."),
      parentId: thread.json().id,
    });
    expect(reply.json()).toMatchObject({
      parentId: thread.json().id,
      anchor: null,
    });
    // Threads are one level deep.
    expect(
      (
        await app.call("POST", `/pages/${pageId}/comments`, "bert", {
          body: doc("x"),
          parentId: reply.json().id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("POST", `/pages/${pageId}/comments`, "bert", {
          body: doc("  "),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.call("GET", `/pages/${pageId}/comments`, "fremd")).statusCode,
    ).toBe(404);
    expect(
      (
        await app.call("POST", `/pages/${pageId}/comments`, "fremd", {
          body: doc("x"),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.call("GET", `/pages/${pageId}/comments`, "anna")).json(),
    ).toHaveLength(2);
  });

  it("lets authors edit and editors resolve", async () => {
    const [thread, reply] = (
      await app.call("GET", `/pages/${pageId}/comments`, "anna")
    ).json();
    expect(
      (
        await app.call("PATCH", `/comments/${thread.id}`, "anna", {
          body: doc("geändert"),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.call("PATCH", `/comments/${thread.id}`, "bert", {
          body: doc("Stimmt das Datum wirklich?"),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.call("PATCH", `/comments/${reply.id}`, "anna", {
          resolved: true,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("PATCH", `/comments/${thread.id}`, "anna", {
          resolved: true,
        })
      ).json().resolved,
    ).toBe(true);
    expect(
      (await app.call("DELETE", `/comments/${thread.id}`, "anna")).statusCode,
    ).toBe(204);
    expect(
      (await app.call("GET", `/pages/${pageId}/comments`, "anna")).json(),
    ).toEqual([]);
  });

  it("turns mentions into an event for notifications", async () => {
    await app.call("POST", `/pages/${pageId}/comments`, "anna", {
      body: doc("Schau mal ", { id: app.ids.bert!, label: "bert" }),
    });
    const events = await app.db
      .selectFrom("core_event")
      .select(["payload_json"])
      .where("type", "=", "page.mentioned")
      .execute();
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload_json).userIds).toEqual([app.ids.bert]);
  });
});
