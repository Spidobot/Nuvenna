// A page: one view for reading and writing (CONCEPT.md §6, a "moment" in §8).
// The space's tree on the left, the live document in the middle with the
// cursors of everyone editing, the table of contents on the right.
import { HocuspocusProvider } from "@hocuspocus/provider";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  issueKeyFrom,
  Menu,
  PageBlocksContext,
  RichTextEditor,
  RichTextView,
  Select,
  useApp,
  useToast,
  type EditorLabels,
  type PageBlocks,
} from "@tvn/ui";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import type { Editor } from "@tiptap/react";
import {
  Download,
  History,
  Link2,
  Lock,
  MessageSquarePlus,
  Plus,
  TicketPlus,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Y from "yjs";
import { PageComments } from "./comments.js";
import { LinkedIssues, PageBar } from "./extras.js";
import { ShareDialog } from "./share.js";
import { QueryDialog } from "./query-block.js";
import { NewTicketDialog } from "./new-ticket.js";
import { RestrictionsDialog } from "./space-settings.js";
import { SpaceTree, usePagesApi, useSpace, useTree } from "./spaces.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;
/** Cursor colours come from the theme, so they follow light and dark mode. */
const COLORS = [
  "var(--color-accent)",
  "var(--color-positive)",
  "var(--color-negative)",
  "var(--color-fg-2)",
];
const colorOf = (id: string) =>
  COLORS[[...id].reduce((h, c) => h + c.charCodeAt(0), 0) % COLORS.length]!;

interface PageData {
  id: string;
  spaceKey: string;
  parentId: string | null;
  title: string;
  content: unknown;
  updatedAt: string;
}
interface Heading {
  level: number;
  text: string;
  pos: number;
}

/** Headings of the document, for the table of contents. */
function headingsOf(editor: Editor): Heading[] {
  const out: Heading[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading")
      out.push({
        level: node.attrs.level as number,
        text: node.textContent,
        pos,
      });
  });
  return out;
}

function Toc({
  headings,
  editor,
}: {
  headings: Heading[];
  editor: Editor | null;
}) {
  const { t } = useTranslation();
  if (!headings.length)
    return <p className="text-sm text-fg-3">{t("app.tocEmpty")}</p>;
  return (
    <ol className="flex flex-col gap-1 text-sm">
      {headings.map((h, i) => (
        <li
          key={i}
          style={{ paddingLeft: `calc(var(--spacing) * ${(h.level - 1) * 3})` }}
        >
          <button
            type="button"
            className="text-left text-fg-2 underline-offset-4 hover:text-fg hover:underline"
            onClick={() => {
              editor?.commands.setTextSelection(h.pos + 1);
              editor?.view
                .domAtPos(h.pos + 1)
                .node.parentElement?.scrollIntoView({
                  behavior: "smooth",
                  block: "start",
                });
            }}
          >
            {h.text || "–"}
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Another page shown inline, read-only. */
function Included({
  pageId,
  setPageId,
  spaceKey,
  self,
}: {
  pageId: string;
  setPageId: (id: string) => void;
  spaceKey: string;
  self: string;
}) {
  const { t } = useTranslation();
  const call = usePagesApi();
  const tree = useTree(spaceKey).data ?? [];
  const page = useQuery({
    queryKey: ["page", pageId],
    queryFn: () => call<PageData>("GET", `/pages/${pageId}`),
    enabled: !!pageId,
    retry: false,
  });
  if (!pageId)
    return (
      <div className="w-72">
        <Select
          aria-label={t("app.includePick")}
          placeholder={t("app.includePick")}
          value={undefined}
          onValueChange={setPageId}
          options={tree
            .filter((p) => p.id !== self)
            .map((p) => ({ value: p.id, label: p.title }))}
        />
      </div>
    );
  if (page.isError)
    return <p className="text-sm text-fg-3">{t("app.includeMissing")}</p>;
  if (!page.data) return null;
  return (
    <div className="flex flex-col gap-2">
      <Link
        to="/spaces/$key/pages/$id"
        params={{ key: page.data.spaceKey, id: page.data.id }}
        className="text-sm font-medium text-fg-2 underline-offset-4 hover:underline"
      >
        {page.data.title}
      </Link>
      <RichTextView doc={page.data.content as never} />
    </div>
  );
}

function Versions({
  pageId,
  canRestore,
  onClose,
}: {
  pageId: string;
  canRestore: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const call = usePagesApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const versions = useQuery({
    queryKey: ["versions", pageId],
    queryFn: () =>
      call<
        {
          number: number;
          message: string | null;
          createdAt: string;
          authorId: string;
        }[]
      >("GET", `/pages/${pageId}/versions`),
  }).data;
  const [compare, setCompare] = useState<number | null>(null);
  const diff = useQuery({
    queryKey: ["compare", pageId, compare],
    queryFn: () =>
      call<{ blocks: { change: string; text: string }[] }>(
        "GET",
        `/pages/${pageId}/compare?from=${compare}&to=current`,
      ),
    enabled: compare !== null,
  }).data;
  const [message, setMessage] = useState("");
  const fail = (e: Error) => toast({ title: e.message, tone: "negative" });
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("app.versions")}
      closeLabel={t("shell.close")}
    >
      <div className="flex flex-col gap-4 pb-2">
        {canRestore && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void call("POST", `/pages/${pageId}/versions`, { message })
                .then(() => {
                  setMessage("");
                  return queryClient.invalidateQueries({
                    queryKey: ["versions", pageId],
                  });
                })
                .catch(fail);
            }}
          >
            <input
              aria-label={t("app.versionMessage")}
              placeholder={t("app.versionMessage")}
              required
              maxLength={500}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="h-8 flex-1 rounded-md border border-line-strong bg-surface px-3 text-sm text-fg"
            />
            <Button size="sm" type="submit">
              {t("app.saveVersion")}
            </Button>
          </form>
        )}
        <ul className="flex flex-col divide-y divide-line">
          {versions?.map((v) => (
            <li
              key={v.number}
              className="flex flex-wrap items-center gap-2 py-2 text-sm"
            >
              <span className="w-8 font-mono text-fg-3">{v.number}</span>
              <span className="flex-1 text-fg">
                {v.message ?? new Date(v.createdAt).toLocaleString()}
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={compare === v.number}
                onClick={() =>
                  setCompare(compare === v.number ? null : v.number)
                }
              >
                {t("app.compare")}
              </Button>
              {canRestore && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void call(
                      "POST",
                      `/pages/${pageId}/versions/${v.number}/restore`,
                    )
                      .then(onClose)
                      .catch(fail)
                  }
                >
                  {t("app.restore")}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {diff && (
          <div
            className="flex flex-col gap-1 rounded-md border border-line p-3 text-sm"
            aria-label={t("app.compare")}
          >
            {diff.blocks.map((b, i) => (
              <p
                key={i}
                className={
                  b.change === "added"
                    ? "text-positive"
                    : b.change === "removed"
                      ? "text-negative line-through"
                      : "text-fg-2"
                }
              >
                {b.change === "added"
                  ? "+ "
                  : b.change === "removed"
                    ? "− "
                    : "  "}
                {b.text || "–"}
              </p>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Asks for a ticket key or link and inserts the ticket block. */
function TicketDialog({
  onClose,
  onInsert,
}: {
  onClose: () => void;
  onInsert: (key: string) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const key = issueKeyFrom(value);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("app.blocks.issue")}
      closeLabel={t("shell.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("app.cancel")}</Button>
          <Button
            variant="primary"
            type="submit"
            form="ticket-form"
            disabled={!key}
          >
            {t("app.insert")}
          </Button>
        </>
      }
    >
      <form
        id="ticket-form"
        className="pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!key) return;
          onInsert(key);
          onClose();
        }}
      >
        <Field label={t("app.ticketKey")} hint={t("app.ticketKeyHint")}>
          {(p) => (
            <Input
              {...p}
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

export function PageView() {
  const { t } = useTranslation();
  const { key, id } = useParams({ from: "/spaces/$key/pages/$id" });
  const { me } = useApp();
  const call = usePagesApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const space = useSpace(key).data;
  const tree = useTree(key).data ?? [];
  const page = useQuery({
    queryKey: ["page", id],
    queryFn: () => call<PageData>("GET", `/pages/${id}`),
  });
  const canEdit = space?.rights.includes("space.edit") ?? false;
  const canShare = space?.rights.includes("space.administer") ?? false;
  const [sharing, setSharing] = useState(false);
  const [restricting, setRestricting] = useState(false);
  const [ticket, setTicket] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [ticketFrom, setTicketFrom] = useState<string | null>(null);

  // One shared document and connection per page.
  const { ydoc, provider } = useMemo(() => {
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `${location.origin.replace(/^http/, "ws")}/nuvenna/api/collab`,
      name: id,
      document: ydoc,
    });
    return { ydoc, provider };
  }, [id]);
  useEffect(() => () => provider.destroy(), [provider]);
  const [synced, setSynced] = useState(false);
  const [people, setPeople] = useState<{ name: string; color: string }[]>([]);
  useEffect(() => {
    setSynced(provider.isSynced);
    const onSynced = () => setSynced(true);
    const onAwareness = () =>
      setPeople(
        [...(provider.awareness?.getStates().values() ?? [])]
          .map((s) => s.user as { name: string; color: string } | undefined)
          .filter((u): u is { name: string; color: string } => !!u),
      );
    provider.on("synced", onSynced);
    provider.awareness?.on("change", onAwareness);
    return () => {
      provider.off("synced", onSynced);
      provider.awareness?.off("change", onAwareness);
    };
  }, [provider]);
  const extensions = useMemo(
    () => [
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({
        provider,
        user: { name: me.displayName, color: colorOf(me.id) },
      }),
    ],
    [ydoc, provider, me],
  );

  const [editor, setEditor] = useState<Editor | null>(null);
  const [headings, setHeadings] = useState<Heading[]>([]);
  useEffect(() => {
    if (!editor) return;
    const update = () => setHeadings(headingsOf(editor));
    update();
    editor.on("update", update);
    return () => void editor.off("update", update);
  }, [editor]);

  const [title, setTitle] = useState<string | null>(null);
  const [versions, setVersions] = useState(false);
  const [quote, setQuote] = useState<string | null>(null);
  const canComment = space?.rights.includes("space.comment") ?? false;
  const children = tree
    .filter((p) => p.parentId === id)
    .sort((a, b) => a.position - b.position);
  const blocks: PageBlocks = {
    toc: () => <Toc headings={headings} editor={editor} />,
    childPages: () =>
      children.length ? (
        <ul className="flex flex-col gap-1 text-sm">
          {children.map((c) => (
            <li key={c.id}>
              <Link
                to="/spaces/$key/pages/$id"
                params={{ key, id: c.id }}
                className="text-fg underline-offset-4 hover:underline"
              >
                {c.title}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-3">{t("app.noChildren")}</p>
      ),
    pageInclude: (pageId, setPageId) => (
      <Included
        pageId={pageId}
        setPageId={setPageId}
        spaceKey={key}
        self={id}
      />
    ),
  };

  if (page.isError) return <EmptyState title={t("app.notFound")} text="" />;
  return (
    <div className="grid items-start gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_13rem] print:block">
      <aside className="max-lg:hidden print:hidden">
        <SpaceTree spaceKey={key} />
      </aside>
      <article className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <div
            className="flex flex-1 items-center gap-1"
            role="group"
            aria-label={t("app.present")}
          >
            {people.map((p, i) => (
              <span
                key={i}
                title={p.name}
                className="inline-flex size-7 items-center justify-center rounded-full border-2 bg-surface text-xs font-medium text-fg"
                style={{ borderColor: p.color }}
              >
                {p.name
                  .split(" ")
                  .map((w) => w[0])
                  .join("")
                  .slice(0, 2)}
              </span>
            ))}
          </div>
          {canEdit && (
            <Menu
              trigger={
                <Button size="sm" variant="ghost">
                  <Plus {...icon} />
                  {t("app.insertBlock")}
                </Button>
              }
              items={[
                ...(["toc", "childPages", "pageInclude"] as const).map(
                  (type) => ({
                    label: t(`app.blocks.${type}`),
                    onSelect: () =>
                      editor?.chain().focus().insertContent({ type }).run(),
                  }),
                ),
                {
                  label: t("app.blocks.issue"),
                  onSelect: () => setTicket(true),
                },
                {
                  label: t("app.blocks.query"),
                  onSelect: () => setQuerying(true),
                },
              ]}
            />
          )}
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const sel = editor?.state.selection;
                const text =
                  sel && !sel.empty
                    ? editor!.state.doc
                        .textBetween(sel.from, sel.to, " ")
                        .trim()
                    : "";
                if (!text)
                  return toast({ title: t("app.newTicket.selectFirst") });
                setTicketFrom(text);
              }}
            >
              <TicketPlus {...icon} />
              {t("app.newTicket.button")}
            </Button>
          )}
          {canComment && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const sel = editor?.state.selection;
                const text =
                  sel && !sel.empty
                    ? editor!.state.doc
                        .textBetween(sel.from, sel.to, " ")
                        .trim()
                    : "";
                if (!text)
                  return toast({ title: t("app.comments.selectFirst") });
                setQuote(text.slice(0, 1000));
                document
                  .getElementById("page-comments")
                  ?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              <MessageSquarePlus {...icon} />
              {t("app.comments.onSelection")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setVersions(true)}>
            <History {...icon} />
            {t("app.versions")}
          </Button>
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRestricting(true)}
            >
              <Lock {...icon} />
              {t("app.restrict.button")}
            </Button>
          )}
          {canShare && (
            <Button size="sm" variant="ghost" onClick={() => setSharing(true)}>
              <Link2 {...icon} />
              {t("app.share.button")}
            </Button>
          )}
          <Menu
            trigger={
              <Button size="sm" variant="ghost">
                <Download {...icon} />
                {t("app.export")}
              </Button>
            }
            items={[
              ...(["markdown", "html"] as const).map((format) => ({
                label: t(`app.exportAs.${format}`),
                onSelect: () =>
                  window.location.assign(
                    `/nuvenna/api/pages/${id}/export?format=${format}`,
                  ),
              })),
              { label: t("app.print"), onSelect: () => window.print() },
            ]}
          />
        </div>
        {page.data &&
          (canEdit ? (
            <input
              aria-label={t("app.title")}
              className="w-full bg-transparent text-2xl font-medium text-fg outline-none"
              value={title ?? page.data.title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                if (
                  title === null ||
                  !title.trim() ||
                  title === page.data!.title
                )
                  return setTitle(null);
                void call("PATCH", `/pages/${id}`, { title: title.trim() })
                  .then(() =>
                    Promise.all([
                      queryClient.invalidateQueries({ queryKey: ["page", id] }),
                      queryClient.invalidateQueries({
                        queryKey: ["tree", key],
                      }),
                    ]),
                  )
                  .then(() => setTitle(null))
                  .catch((e: Error) =>
                    toast({ title: e.message, tone: "negative" }),
                  );
              }}
            />
          ) : (
            <h1 className="text-2xl font-medium text-fg">{page.data.title}</h1>
          ))}
        <div className="print:hidden">
          <PageBar pageId={id} canEdit={canEdit} />
        </div>
        {/* Until the shared document arrives, the stored content is shown. */}
        {!synced && page.data && (
          <RichTextView doc={page.data.content as never} />
        )}
        <div hidden={!synced}>
          <PageBlocksContext.Provider value={blocks}>
            <RichTextEditor
              key={id}
              value={null}
              collaborative
              bare
              editable={canEdit}
              label={page.data?.title ?? ""}
              labels={t("editor", { returnObjects: true }) as EditorLabels}
              extensions={extensions}
              onReady={setEditor}
            />
          </PageBlocksContext.Provider>
        </div>
        <div className="print:hidden">
          <LinkedIssues pageId={id} />
        </div>
        <div id="page-comments" className="print:hidden">
          <PageComments
            pageId={id}
            canComment={canComment}
            canResolve={canEdit}
            editor={editor}
            quote={quote}
            onQuoteUsed={() => setQuote(null)}
          />
        </div>
      </article>
      <aside className="max-xl:hidden xl:sticky xl:top-4 print:hidden">
        <h2 className="mb-2 text-sm font-medium text-fg-2">{t("app.toc")}</h2>
        <Toc headings={headings} editor={editor} />
      </aside>
      {ticketFrom !== null && (
        <NewTicketDialog
          text={ticketFrom}
          onClose={() => setTicketFrom(null)}
          onCreated={(key) => {
            if (!editor) return;
            // Below the block the selection ends in.
            const at = editor.state.selection.$to.after(1);
            editor
              .chain()
              .focus()
              .insertContentAt(at, { type: "issue", attrs: { key } })
              .run();
          }}
        />
      )}
      {querying && (
        <QueryDialog
          onClose={() => setQuerying(false)}
          onInsert={(attrs) =>
            editor
              ?.chain()
              .focus()
              .insertContent({ type: "query", attrs })
              .run()
          }
        />
      )}
      {ticket && (
        <TicketDialog
          onClose={() => setTicket(false)}
          onInsert={(key) =>
            editor
              ?.chain()
              .focus()
              .insertContent({ type: "issue", attrs: { key } })
              .run()
          }
        />
      )}
      {restricting && (
        <RestrictionsDialog pageId={id} onClose={() => setRestricting(false)} />
      )}
      {sharing && <ShareDialog pageId={id} onClose={() => setSharing(false)} />}
      {versions && (
        <Versions
          pageId={id}
          canRestore={canEdit}
          onClose={() => setVersions(false)}
        />
      )}
    </div>
  );
}
