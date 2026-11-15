import { grantGlobal, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import type { Kysely } from "kysely";
import { inflateRawSync } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PagesDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

/** Names and contents of a ZIP, read through its central directory. */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = buf.readUInt32LE(buf.length - 6);
  while (buf.readUInt32LE(at) === 0x02014b50) {
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const local = buf.readUInt32LE(at + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26);
    out[name] = inflateRawSync(buf.subarray(start, start + size)).toString(
      "utf8",
    );
    at += 46 + nameLen;
  }
  return out;
}

describeEachDb<PagesDb>("export and import", (t) => {
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
    await app.call("POST", "/spaces", "anna", { key: "DOC", name: "Doku" });
  }, 180_000);
  afterAll(() => app?.close());

  it("imports a folder of Markdown files as a page tree", async () => {
    const res = await app.call("POST", "/spaces/DOC/import", "anna", {
      files: [
        { path: "IT/README.md", content: "# IT-Wissen\n\nAlles zur IT." },
        { path: "IT/drucker.md", content: "# Drucker\n\nToner im **Lager**." },
        { path: "IT/Netz/vpn.md", content: "Zugang über WireGuard." },
        { path: "IT/bild.png", content: "x" },
        { path: "../../etc/passwd.md", content: "nur Text" },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ created: 6 });
    const tree = (await app.call("GET", "/spaces/DOC/tree", "anna")).json() as {
      id: string;
      parentId: string | null;
      title: string;
    }[];
    const byTitle = (title: string) => tree.find((p) => p.title === title)!;
    expect(byTitle("Drucker").parentId).toBe(byTitle("IT-Wissen").id);
    expect(byTitle("vpn").parentId).toBe(byTitle("Netz").id);
    expect(byTitle("Netz").parentId).toBe(byTitle("IT-Wissen").id);
    // ".." is dropped: the path never climbs out of where the import goes.
    expect(byTitle("passwd").parentId).toBe(byTitle("etc").id);
    expect(byTitle("etc").parentId).toBe(byTitle("IT-Wissen").parentId);
    const page = (
      await app.call("GET", `/pages/${byTitle("Drucker").id}`, "anna")
    ).json();
    expect(JSON.stringify(page.content)).toContain('"bold"');
    expect(
      (
        await app.call("POST", "/spaces/DOC/import", "gast", {
          files: [{ path: "a.md", content: "x" }],
        })
      ).statusCode,
    ).toBe(403);
  });

  it("exports a page as Markdown and HTML", async () => {
    const tree = (await app.call("GET", "/spaces/DOC/tree", "anna")).json();
    const id = tree.find((p: { title: string }) => p.title === "Drucker").id;
    const md = await app.call("GET", `/pages/${id}/export`, "gast");
    expect(md.headers["content-disposition"]).toContain("Drucker.md");
    expect(md.body).toBe("# Drucker\n\nToner im **Lager**.\n");
    const html = await app.call(
      "GET",
      `/pages/${id}/export?format=html`,
      "gast",
    );
    expect(html.body).toContain("<strong>Lager</strong>");
    expect(html.body).toContain("@media print");
  });

  it("exports a space as a ZIP following the tree, without hidden pages", async () => {
    const tree = (await app.call("GET", "/spaces/DOC/tree", "anna")).json();
    const netz = tree.find((p: { title: string }) => p.title === "Netz").id;
    await app.db
      .insertInto("pages_page_restriction")
      .values({
        id: "r",
        page_id: netz,
        kind: "view",
        grantee_type: "user",
        grantee_id: app.ids.anna!,
      })
      .execute();
    const res = await app.call("GET", "/spaces/DOC/export", "gast");
    expect(res.headers["content-type"]).toBe("application/zip");
    const files = unzip(res.rawPayload);
    expect(Object.keys(files).sort()).toEqual([
      "Doku.md",
      "Doku/IT-Wissen.md",
      "Doku/IT-Wissen/Drucker.md",
      "Doku/etc.md",
      "Doku/etc/passwd.md",
    ]);
    expect(files["Doku/IT-Wissen/Drucker.md"]).toContain("**Lager**");
    expect(
      Object.keys(
        unzip((await app.call("GET", "/spaces/DOC/export", "anna")).rawPayload),
      ),
    ).toContain("Doku/IT-Wissen/Netz/vpn.md");
  });
});
