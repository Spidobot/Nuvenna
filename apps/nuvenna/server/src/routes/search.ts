// Full-text search over title and content_text, only what the reader may see.
// Normalised text and LIKE, as the concept says; nothing vendor-specific.
import { escapeLike, excerpt, likeCi, requireUser } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { PagesAccess } from "../access.js";
import type { PagesDb } from "../db/schema.js";

export async function searchRoutes(
  scope: FastifyInstance,
  db: Kysely<PagesDb>,
  access: PagesAccess,
): Promise<void> {
  scope.withTypeProvider<ZodTypeProvider>().get(
    "/search",
    {
      config: { permission: "authenticated" as const },
      schema: {
        querystring: z.object({
          q: z.string().trim().min(2).max(200),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              spaceKey: z.string(),
              title: z.string(),
              kind: z.string(),
              excerpt: z.string(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const { q, limit } = req.query;
      const spaceIds = await access.visibleSpaceIds(user);
      if (!spaceIds.length) return [];
      const hidden = await access.hiddenPageIds(user, spaceIds);
      const pattern = `%${escapeLike(q)}%`;
      const rows = await db
        .selectFrom("pages_page as p")
        .innerJoin("pages_space as s", "s.id", "p.space_id")
        .select(["p.id", "s.space_key", "p.title", "p.kind", "p.content_text"])
        .where("p.space_id", "in", spaceIds)
        .where("p.status", "=", "current")
        .where((eb) =>
          eb.or([
            likeCi(eb.ref("p.title"), pattern),
            likeCi(eb.ref("p.content_text"), pattern),
          ]),
        )
        .orderBy("p.updated_at", "desc")
        // Hidden pages are dropped afterwards; fetch some extra for them.
        .limit(limit + hidden.size)
        .execute();
      const lower = q.toLowerCase();
      return (
        rows
          .filter((p) => !hidden.has(p.id))
          // Title hits first, otherwise newest first.
          .sort(
            (a, b) =>
              Number(b.title.toLowerCase().includes(lower)) -
              Number(a.title.toLowerCase().includes(lower)),
          )
          .slice(0, limit)
          .map((p) => ({
            id: p.id,
            spaceKey: p.space_key,
            title: p.title,
            kind: p.kind,
            excerpt: excerpt(p.content_text, q),
          }))
      );
    },
  );
}
