// Public links to one page. The token is shown once and stored only as a
// hash. A reader without an account sees that page and nothing else: blocks
// that would show other pages or files behind a sign-in are left out.
import { createHash, randomBytes } from "node:crypto";
import {
  AppError,
  requireUser,
  uuidv7,
  type AppContext,
  type RichNode,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { PagesAccess } from "../access.js";
import type { PagesDb } from "../db/schema.js";

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const notFound = () => new AppError(404, "not_found", "Not found");

/** Sub-page lists and included pages need the reader's rights; images and files need a sign-in. */
const NOT_PUBLIC = new Set([
  "childPages",
  "pageInclude",
  "image",
  "attachment",
  "query",
]);
function publicDoc(n: RichNode): RichNode {
  return n.content
    ? {
        ...n,
        content: n.content
          .filter((c) => !NOT_PUBLIC.has(c.type))
          .map(publicDoc),
      }
    : n;
}

export async function shareRoutes(
  scope: FastifyInstance,
  app: AppContext,
  db: Kysely<PagesDb>,
  access: PagesAccess,
): Promise<void> {
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const custom = { permission: "custom" as const };
  const shareOut = z.object({
    id: z.string(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
  });
  const present = (s: PagesDb["pages_public_share"]) => ({
    id: s.id,
    expiresAt: s.expires_at?.toISOString() ?? null,
    createdAt: s.created_at.toISOString(),
  });

  /** The page, if this user may manage its public links. */
  async function manageable(
    userId: ReturnType<typeof requireUser>,
    pageId: string,
  ) {
    const page = await db
      .selectFrom("pages_page")
      .selectAll()
      .where("id", "=", pageId)
      .executeTakeFirst();
    const target = page && { spaceId: page.space_id, pageId: page.id };
    if (!page || !target || !(await access.can(userId, "space.view", target)))
      throw notFound();
    // Making a page public is a decision about the whole space.
    if (!(await access.can(userId, "space.administer", target)))
      throw new AppError(
        403,
        "forbidden",
        "Only space administrators can share pages publicly",
      );
    return page;
  }

  r.get(
    "/pages/:id/shares",
    {
      config: custom,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.array(shareOut) },
      },
    },
    async (req) => {
      const page = await manageable(requireUser(req), req.params.id);
      const rows = await db
        .selectFrom("pages_public_share")
        .selectAll()
        .where("page_id", "=", page.id)
        .orderBy("created_at")
        .execute();
      return rows.map(present);
    },
  );

  r.post(
    "/pages/:id/shares",
    {
      config: custom,
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
        }),
        response: { 201: shareOut.extend({ url: z.string() }) },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const page = await manageable(user, req.params.id);
      const expires = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
      if (expires && expires.getTime() <= Date.now())
        throw new AppError(
          400,
          "validation",
          "The expiry date must lie in the future",
        );
      const token = randomBytes(32).toString("base64url");
      const row = {
        id: uuidv7(),
        page_id: page.id,
        token_hash: hash(token),
        expires_at: expires,
        created_by: user.id,
        created_at: new Date(),
      };
      await db.insertInto("pages_public_share").values(row).execute();
      // The token goes after "#": browsers never send it to a server or in a Referer.
      return reply
        .status(201)
        .send({ ...present(row), url: `${app.baseUrl}/share#${token}` });
    },
  );

  r.delete(
    "/pages/:id/shares/:shareId",
    {
      config: custom,
      schema: {
        params: z.object({ id: z.string(), shareId: z.string() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const page = await manageable(requireUser(req), req.params.id);
      await db
        .deleteFrom("pages_public_share")
        .where("id", "=", req.params.shareId)
        .where("page_id", "=", page.id)
        .execute();
      return reply.status(204).send(null);
    },
  );

  // POST so the token stays out of access logs.
  r.post(
    "/shared",
    {
      config: {
        permission: "public" as const,
        // Tokens are long enough not to guess, but nobody needs 60 tries a minute.
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
      schema: {
        body: z.object({ token: z.string().min(20).max(100) }),
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
      const share = await db
        .selectFrom("pages_public_share as s")
        .innerJoin("pages_page as p", "p.id", "s.page_id")
        .select([
          "s.expires_at",
          "p.title",
          "p.content_json",
          "p.status",
          "p.updated_at",
        ])
        .where("s.token_hash", "=", hash(req.body.token))
        .executeTakeFirst();
      if (
        !share ||
        share.status !== "current" ||
        (share.expires_at && share.expires_at.getTime() <= Date.now())
      )
        throw notFound();
      return {
        title: share.title,
        content: publicDoc(JSON.parse(share.content_json)),
        updatedAt: share.updated_at.toISOString(),
      };
    },
  );
}
