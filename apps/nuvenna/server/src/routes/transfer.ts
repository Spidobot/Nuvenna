// Export of a page or a whole space as Markdown or HTML. A space comes as a
// ZIP whose folders follow the page tree. Import lives with the tree in
// spaces.ts, where pages are created.
import { AppError, renderHtml, renderMarkdown, requireUser } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { PagesAccess } from "../access.js";
import type { PagesDb } from "../db/schema.js";
import { Readable } from "node:stream";
import { zipStream } from "../zip.js";

type Page = PagesDb["pages_page"];
const notFound = () => new AppError(404, "not_found", "Not found");
const format = z.object({
  format: z.enum(["markdown", "html"]).default("markdown"),
});

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** A standalone HTML file that prints well; the browser makes the PDF. */
const htmlFile = (title: string, body: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}
pre{overflow:auto;padding:.75rem;border:1px solid #8884}
table{border-collapse:collapse}td,th{border:1px solid #8886;padding:.25rem .5rem}
blockquote,[role=note]{margin:0;padding-left:1rem;border-left:3px solid #8886}
img{max-width:100%}
@media print{body{margin:0;max-width:none}a{color:inherit}h1,h2,h3{break-after:avoid}pre,table,img{break-inside:avoid}}
</style></head>
<body><h1>${escape(title)}</h1>
${body}
</body></html>
`;
const fileOf = (
  p: Pick<Page, "title" | "content_json">,
  kind: "markdown" | "html",
) => {
  const doc = JSON.parse(p.content_json);
  return kind === "html"
    ? htmlFile(p.title, renderHtml(doc))
    : `# ${p.title}\n\n${renderMarkdown(doc)}`;
};
const ext = (kind: "markdown" | "html") => (kind === "html" ? "html" : "md");
/** A file name from a title: no path characters, never empty. */
const safeName = (title: string) =>
  title
    // eslint-disable-next-line no-control-regex -- control characters are exactly what must go
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 100) || "page";
const disposition = (name: string) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

export async function transferRoutes(
  scope: FastifyInstance,
  db: Kysely<PagesDb>,
  access: PagesAccess,
): Promise<void> {
  const r = scope.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/pages/:id/export",
    {
      config: { permission: "custom" as const },
      schema: { params: z.object({ id: z.string() }), querystring: format },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const page = await db
        .selectFrom("pages_page")
        .selectAll()
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (
        !page ||
        page.status !== "current" ||
        !(await access.can(user, "space.view", {
          spaceId: page.space_id,
          pageId: page.id,
        }))
      )
        throw notFound();
      const kind = req.query.format;
      return reply
        .header(
          "content-type",
          kind === "html"
            ? "text/html; charset=utf-8"
            : "text/markdown; charset=utf-8",
        )
        .header(
          "content-disposition",
          disposition(`${safeName(page.title)}.${ext(kind)}`),
        )
        .send(fileOf(page, kind));
    },
  );

  r.get(
    "/spaces/:key/export",
    {
      config: { permission: "custom" as const },
      schema: {
        params: z.object({ key: z.string().max(20) }),
        querystring: format,
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const space = await db
        .selectFrom("pages_space")
        .selectAll()
        .where("space_key", "=", req.params.key.toUpperCase())
        .executeTakeFirst();
      if (
        !space ||
        !(await access.can(user, "space.view", { spaceId: space.id }))
      )
        throw notFound();
      const hidden = await access.hiddenPageIds(user, [space.id]);
      // The tree without content first; each page's content is read when its
      // turn comes, so a large space never sits in memory as a whole.
      const pages = (
        await db
          .selectFrom("pages_page")
          .select(["id", "parent_id", "title"])
          .where("space_id", "=", space.id)
          .where("status", "=", "current")
          .where("kind", "=", "page")
          .orderBy("position")
          .execute()
      ).filter((p) => !hidden.has(p.id));
      const ids = new Set(pages.map((p) => p.id));
      const kind = req.query.format;
      const files: { name: string; id: string }[] = [];
      // A page is "Title.md"; its sub-pages sit in the folder "Title/".
      const walk = (parentId: string | null, dir: string) => {
        const used = new Set<string>();
        for (const p of pages.filter((x) =>
          parentId
            ? x.parent_id === parentId
            : !x.parent_id || !ids.has(x.parent_id),
        )) {
          let name = safeName(p.title);
          for (let n = 2; used.has(name.toLowerCase()); n++)
            name = `${safeName(p.title)} (${n})`;
          used.add(name.toLowerCase());
          files.push({ name: `${dir}${name}.${ext(kind)}`, id: p.id });
          walk(p.id, `${dir}${name}/`);
        }
      };
      walk(null, "");
      return reply
        .header("content-type", "application/zip")
        .header(
          "content-disposition",
          disposition(`${space.space_key}-${ext(kind)}.zip`),
        )
        .send(
          Readable.from(
            zipStream(
              (async function* () {
                for (const file of files) {
                  const page = await db
                    .selectFrom("pages_page")
                    .select(["title", "content_json"])
                    .where("id", "=", file.id)
                    .executeTakeFirst();
                  if (page)
                    yield {
                      name: file.name,
                      data: Buffer.from(fileOf(page, kind)),
                    };
                }
              })(),
            ),
          ),
        );
    },
  );
}
