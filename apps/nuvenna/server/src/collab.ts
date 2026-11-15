// Real-time editing (CONCEPT.md §6): Hocuspocus inside the Nuvenna process.
// A connection signs in with the session cookie (or an API token), may read
// a page to connect and may edit it to write; otherwise it is read-only.
// Stored state goes to pages_page_ydoc, and content_json / content_text
// are derived from it, so nothing else ever needs Yjs.
import websocket from "@fastify/websocket";
import {
  renderText,
  resolveApiToken,
  resolveSession,
  type AppContext,
  type AuthUser,
  type CoreDb,
} from "@tvn/core";
import { Hocuspocus } from "@hocuspocus/server";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import * as Y from "yjs";
import type { PagesAccess } from "./access.js";
import type { PagesDb } from "./db/schema.js";
import { docToYdoc, ydocToDoc } from "./ydoc.js";

interface Context {
  user: AuthUser;
}

const cookie = (header: string | null, name: string) =>
  header
    ?.split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === name)?.[1];

/**
 * The session cookie of a socket, if it may be used. A cookie travels with a
 * socket opened by any site; accept it only from our own pages, as the HTTP
 * routes do for writes. API tokens need no such check.
 */
/** Largest WebSocket message accepted, and open pages per account. */
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CONNECTIONS_PER_USER = 50;

export function sessionCookie(headers: Headers, origin: string) {
  return headers.get("origin") === origin
    ? cookie(headers.get("cookie"), "tvn_session")
    : undefined;
}

export async function installCollab(
  scope: FastifyInstance,
  app: AppContext,
  db: Kysely<PagesDb>,
  access: PagesAccess,
): Promise<Hocuspocus<Context>> {
  const core = db as unknown as Kysely<CoreDb>;
  const origin = new URL(app.baseUrl).origin;
  const pageOf = (id: string) =>
    db
      .selectFrom("pages_page")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
  const target = (p: { space_id: string; id: string }) => ({
    spaceId: p.space_id,
    pageId: p.id,
  });

  /** Open documents per user, to cap them. */
  const open = new Map<string, number>();
  const hocuspocus = new Hocuspocus<Context>({
    // Saved two seconds after typing stops, at the latest every ten seconds.
    debounce: 2000,
    maxDebounce: 10_000,
    quiet: true,

    async onDisconnect({ context }) {
      const id = context?.user?.id;
      if (!id) return;
      const left = (open.get(id) ?? 1) - 1;
      if (left > 0) open.set(id, left);
      else open.delete(id);
    },

    async onAuthenticate({
      token,
      requestHeaders,
      documentName,
      connectionConfig,
    }) {
      const session = sessionCookie(requestHeaders, origin);
      const user =
        (token ? await resolveApiToken(core, token) : null) ??
        (session
          ? await resolveSession(core, decodeURIComponent(session))
          : null);
      const page = await pageOf(documentName);
      if (
        !user ||
        !page ||
        page.status !== "current" ||
        !(await access.can(user, "space.view", target(page)))
      )
        throw new Error("Not allowed");
      // A handful of tabs is normal; hundreds of sockets from one account are not.
      if ((open.get(user.id) ?? 0) >= MAX_CONNECTIONS_PER_USER)
        throw new Error("Too many open pages");
      open.set(user.id, (open.get(user.id) ?? 0) + 1);
      connectionConfig.readOnly = !(await access.can(
        user,
        "space.edit",
        target(page),
      ));
      return { user };
    },

    async onLoadDocument({ document, documentName }) {
      const row = await db
        .selectFrom("pages_page_ydoc")
        .select("state")
        .where("page_id", "=", documentName)
        .executeTakeFirst();
      if (row) {
        Y.applyUpdate(document, new Uint8Array(row.state));
        return document;
      }
      // First edit of a page: start from its stored content, and keep that
      // state at once. Built again on the next load it would get new client
      // ids, and a client still holding the first one would see it twice.
      const page = await pageOf(documentName);
      if (!page) return document;
      const state = Y.encodeStateAsUpdate(
        docToYdoc(JSON.parse(page.content_json)),
      );
      try {
        await db
          .insertInto("pages_page_ydoc")
          .values({
            page_id: page.id,
            state: Buffer.from(state),
            updated_at: new Date(),
          })
          .execute();
        Y.applyUpdate(document, state);
      } catch {
        // Another instance got there first: take its state.
        const won = await db
          .selectFrom("pages_page_ydoc")
          .select("state")
          .where("page_id", "=", documentName)
          .executeTakeFirstOrThrow();
        Y.applyUpdate(document, new Uint8Array(won.state));
      }
      return document;
    },

    async onStoreDocument({ document, documentName, lastContext }) {
      const page = await pageOf(documentName);
      if (!page) return;
      const doc = ydocToDoc(document);
      const json = JSON.stringify(doc);
      const state = Buffer.from(Y.encodeStateAsUpdate(document));
      const now = new Date();
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("pages_page_ydoc")
          .where("page_id", "=", page.id)
          .execute();
        await trx
          .insertInto("pages_page_ydoc")
          .values({ page_id: page.id, state, updated_at: now })
          .execute();
        if (json === page.content_json) return;
        await trx
          .updateTable("pages_page")
          .set({
            content_json: json,
            content_text: renderText(doc),
            version: page.version + 1,
            updated_by: lastContext?.user?.id ?? page.updated_by,
            updated_at: now,
          })
          .where("id", "=", page.id)
          .execute();
        await app.queue.emit(trx as unknown as Kysely<CoreDb>, {
          type: "page.updated",
          actorId: lastContext?.user?.id ?? null,
          entityType: "page",
          entityId: page.id,
          payload: { spaceId: page.space_id, title: page.title },
        });
      });
    },
  });

  /**
   * Checks every open connection again: whoever lost the right to read is
   * disconnected, whoever lost the right to write becomes read-only.
   */
  async function revalidate() {
    for (const [name, document] of hocuspocus.documents) {
      const page = await pageOf(name);
      for (const connection of document.getConnections()) {
        const user = (connection.context as Context | undefined)?.user;
        const sees =
          !!user &&
          !!page &&
          page.status === "current" &&
          (await access.can(user, "space.view", target(page)));
        if (!sees) connection.close();
        else
          connection.readOnly = !(await access.can(
            user,
            "space.edit",
            target(page),
          ));
      }
    }
  }
  // Whatever can change who sees or edits a page.
  app.queue.on(
    "pages-collab-rights",
    [
      "page.trashed",
      "page.moved",
      "page.deleted",
      "page.restricted",
      "space.permissions_changed",
      "space.updated",
      "user.updated",
      "group.*",
    ],
    () => revalidate(),
  );

  // One Yjs update is small; anything near this size is not typing.
  await scope.register(websocket, {
    options: { maxPayload: MAX_MESSAGE_BYTES },
  });
  scope.get(
    "/collab",
    // Signed in by onAuthenticate; the route itself is open.
    { websocket: true, config: { permission: "public" as const } },
    (socket, req) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === "string") headers.set(k, v);
      const connection = hocuspocus.handleConnection(
        socket,
        new Request(`http://localhost${req.url}`, { headers }),
      );
      // Hocuspocus 4 leaves the socket events to the integration.
      socket.on("message", (data: Buffer) =>
        connection.handleMessage(new Uint8Array(data)),
      );
      socket.on("close", (code: number, reason: Buffer) =>
        connection.handleClose({
          code,
          reason: reason.toString(),
        } as CloseEvent),
      );
      socket.on("pong", () => connection.touch());
    },
  );
  scope.addHook("onClose", async () => {
    await hocuspocus.flushPendingStores?.();
  });
  return hocuspocus;
}
