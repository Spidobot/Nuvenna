import { grantGlobal, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PagesDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<PagesDb>(
  "labels, watching, favourites, blog and notifications",
  (t) => {
    let app: TestApp;
    let home: string;
    let pageId: string;
    const drain = async () => {
      while ((await app.running.queue.runDue()) > 0);
    };
    const inbox = async (who: string) =>
      (await app.call("GET", "/core/notifications", who)).json().items as {
        title: string;
        text: string;
        url: string;
      }[];

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
      home = space.homePageId;
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
      pageId = (
        await app.call("POST", "/spaces/DOC/pages", "anna", {
          title: "Plan",
          parentId: home,
        })
      ).json().id;
      await drain();
    }, 180_000);
    afterAll(() => app?.close());

    it("keeps labels, likes, favourites and visits per user", async () => {
      expect(
        (
          await app.call("PUT", `/pages/${pageId}/labels`, "gast", {
            labels: ["x"],
          })
        ).statusCode,
      ).toBe(403);
      await app.call("PUT", `/pages/${pageId}/labels`, "anna", {
        labels: ["Planung", "q4", "planung"],
      });
      for (const who of ["anna", "bert"])
        await app.call("PUT", `/pages/${pageId}/like`, who);
      await app.call("PUT", `/pages/${pageId}/like`, "anna");
      await app.call("PUT", `/pages/${pageId}/favorite`, "gast");
      await app.call("POST", `/pages/${pageId}/visit`, "gast");
      expect(
        (await app.call("GET", `/pages/${pageId}/meta`, "gast")).json(),
      ).toEqual({
        labels: ["planung", "q4"],
        watching: false,
        favorite: true,
        liked: false,
        likes: 2,
      });
      expect(
        (await app.call("GET", "/labels/planung", "gast"))
          .json()
          .map((p: { title: string }) => p.title),
      ).toEqual(["Plan"]);
      expect(
        (await app.call("GET", "/me/favorites", "gast"))
          .json()
          .map((p: { id: string }) => p.id),
      ).toEqual([pageId]);
      expect(
        (await app.call("GET", "/me/recent", "gast"))
          .json()
          .map((p: { id: string }) => p.id),
      ).toEqual([pageId]);
      await app.call("DELETE", `/pages/${pageId}/favorite`, "gast");
      expect((await app.call("GET", "/me/favorites", "gast")).json()).toEqual(
        [],
      );
    });

    it("lists blog posts newest first", async () => {
      for (const title of ["Erster Beitrag", "Zweiter Beitrag"]) {
        await app.call("POST", "/spaces/DOC/pages", "anna", {
          title,
          kind: "blog",
        });
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(
        (await app.call("GET", "/spaces/DOC/blog", "gast"))
          .json()
          .map((p: { title: string }) => p.title),
      ).toEqual(["Zweiter Beitrag", "Erster Beitrag"]);
    });

    it("tells watchers and mentioned people, not the one who acted", async () => {
      // anna created the page and so watches it; gast chooses to.
      await app.call("PUT", `/pages/${pageId}/watch`, "gast");
      await app.call("POST", `/pages/${pageId}/comments`, "bert", {
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Gute Idee" }],
            },
          ],
        },
      });
      await drain();
      for (const who of ["anna", "gast"]) {
        const items = await inbox(who);
        expect(items[0], who).toMatchObject({
          title: "Plan",
          url: `/nuvenna/spaces/DOC/pages/${pageId}`,
        });
        expect(items[0]!.text).toMatch(/bert/);
      }
      expect(await inbox("bert")).toEqual([]);
      // bert commented and now watches too: anna's sub-page reaches him.
      await app.call("POST", "/spaces/DOC/pages", "anna", {
        title: "Unterseite",
        parentId: pageId,
      });
      await drain();
      expect((await inbox("bert"))[0]!.text).toMatch(/anna/);
    });
  },
);
