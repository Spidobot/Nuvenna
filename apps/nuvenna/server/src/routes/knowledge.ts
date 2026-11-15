// The knowledge base for the portal: a space its administrators offer to
// customers. Customers get nothing else from Nuvenna. Only pages without any
// view restriction (on themselves or above) are offered, without blocks that
// need rights; that is the same cut as for public links.
import {
  AppError,
  escapeLike,
  excerpt,
  likeCi,
  requireUser,
  type RichNode,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { PagesAccess } from "../access.js";
import type { PagesDb } from "../db/schema.js";

const notFound = () => new AppError(404, "not_found", "Not found");
const NOT_OFFERED = new Set([
  "childPages",
  "pageInclude",
  "image",
  "attachment",
  "query",
]);
const offered = (n: RichNode): RichNode =>
  n.content
    ? {
        ...n,
        content: n.content.filter((c) => !NOT_OFFERED.has(c.type)).map(offered),
      }
    : n;

export async function knowledgeRoutes(
  scope: FastifyInstance,
  db: Kysely<PagesDb>,
  access: PagesAccess,
): Promise<void> {
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const signedIn = { permission: "authenticated" as const };

  async function base(key: string) {
    const space = await db
      .selectFrom("pages_space")
      .select(["id", "knowledge_base"])
      .where("space_key", "=", key.toUpperCase())
      .executeTakeFirst();
    if (!space || !space.knowledge_base) throw notFound();
    // Restricted to anyone means hidden here: nobody is signed in as "null".
    const hidden = await access.hiddenPageIds(null, [space.id]);
    return { id: space.id, hidden };
  }

  r.get(
    "/kb/:key/search",
    {
      config: signedIn,
      schema: {
        params: z.object({ key: z.string().max(20) }),
        querystring: z.object({ q: z.string().trim().min(2).max(200) }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              excerpt: z.string(),
            }),
          ),
        },
      },
    },
    async (req) => {
      requireUser(req);
      const { id, hidden } = await base(req.params.key);
      // Every word counts, so "drucker druckt nicht" finds the printer page.
      const words = req.query.q.split(/\s+/).filter((w) => w.length > 2);
      if (!words.length) return [];
      const rows = await db
        .selectFrom("pages_page")
        .select(["id", "title", "content_text"])
        .where("space_id", "=", id)
        .where("status", "=", "current")
        .where("kind", "=", "page")
        .where((eb) =>
          eb.or(
            words.flatMap((w) => [
              likeCi(eb.ref("title"), `%${escapeLike(w)}%`),
              likeCi(eb.ref("content_text"), `%${escapeLike(w)}%`),
            ]),
          ),
        )
        .orderBy("updated_at", "desc")
        .limit(20 + hidden.size)
        .execute();
      const score = (p: (typeof rows)[number]) => {
        const hay = `${p.title} ${p.content_text}`.toLowerCase();
        return words.filter((w) => hay.includes(w.toLowerCase())).length;
      };
      return rows
        .filter((p) => !hidden.has(p.id))
        .sort((a, b) => score(b) - score(a))
        .slice(0, 5)
        .map((p) => ({
          id: p.id,
          title: p.title,
          excerpt: excerpt(p.content_text, words[0]!),
        }));
    },
  );

  r.get(
    "/kb/:key/pages/:id",
    {
      config: signedIn,
      schema: {
        params: z.object({ key: z.string().max(20), id: z.string() }),
        response: {
          200: z.object({
            title: z.string(),
            content: z.unknown(),
            updatedAt: z.string(),
          }),
        },
      },
    },
    async (req) => {
      requireUser(req);
      const { id, hidden } = await base(req.params.key);
      const page = await db
        .selectFrom("pages_page")
        .select(["id", "title", "content_json", "updated_at", "status", "kind"])
        .where("id", "=", req.params.id)
        .where("space_id", "=", id)
        .executeTakeFirst();
      if (
        !page ||
        page.status !== "current" ||
        page.kind !== "page" ||
        hidden.has(page.id)
      )
        throw notFound();
      return {
        title: page.title,
        content: offered(JSON.parse(page.content_json)),
        updatedAt: page.updated_at.toISOString(),
      };
    },
  );
}
