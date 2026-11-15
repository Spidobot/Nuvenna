// Comment threads under a page: on the whole page or on a quoted passage,
// with replies, resolving and @mentions.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  RichTextEditor,
  RichTextView,
  useApp,
  useToast,
  type EditorLabels,
  type RichTextEditorProps,
} from "@tvn/ui";
import type { Editor } from "@tiptap/react";
import { MessageSquare } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePagesApi } from "./spaces.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;
type Doc = RichTextEditorProps["value"];

interface Comment {
  id: string;
  parentId: string | null;
  anchor: { quote: string } | null;
  body: Doc;
  authorId: string;
  resolved: boolean;
  createdAt: string;
}

/** Selects the first place where the quoted passage still stands. */
export function revealQuote(editor: Editor | null, quote: string) {
  if (!editor) return false;
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null || !node.isText) return found === null;
    const at = node.text!.indexOf(quote);
    if (at >= 0) found = pos + at;
    return false;
  });
  if (found === null) return false;
  editor
    .chain()
    .focus()
    .setTextSelection({ from: found, to: found + quote.length })
    .scrollIntoView()
    .run();
  return true;
}

function Composer({
  onSend,
  label,
  autoFocusKey,
}: {
  onSend: (body: Doc) => Promise<unknown>;
  label: string;
  autoFocusKey?: string;
}) {
  const { t } = useTranslation();
  const { api } = useApp();
  const [body, setBody] = useState<Doc>(null);
  const [round, setRound] = useState(0);
  const searchUsers = (q: string) =>
    api
      .call<{ id: string; displayName: string }[]>(
        "GET",
        `/core/users?q=${encodeURIComponent(q)}&limit=8`,
      )
      .then((users) => users.map((u) => ({ id: u.id, label: u.displayName })));
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (body)
          void onSend(body).then(() => {
            setBody(null);
            setRound((n) => n + 1);
          });
      }}
    >
      <RichTextEditor
        key={`${round}-${autoFocusKey ?? ""}`}
        compact
        label={label}
        labels={t("editor", { returnObjects: true }) as EditorLabels}
        value={null}
        onChange={setBody}
        searchUsers={searchUsers}
      />
      <div>
        <Button size="sm" variant="primary" type="submit" disabled={!body}>
          {t("app.comments.send")}
        </Button>
      </div>
    </form>
  );
}

export function PageComments({
  pageId,
  canComment,
  canResolve,
  editor,
  quote,
  onQuoteUsed,
}: {
  pageId: string;
  canComment: boolean;
  canResolve: boolean;
  editor: Editor | null;
  /** A passage the reader selected to comment on. */
  quote: string | null;
  onQuoteUsed: () => void;
}) {
  const { t } = useTranslation();
  const { me, api } = useApp();
  const call = usePagesApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ["comments", pageId];
  const comments =
    useQuery({
      queryKey: key,
      queryFn: () => call<Comment[]>("GET", `/pages/${pageId}/comments`),
    }).data ?? [];
  const users = useQuery({
    queryKey: ["users-short"],
    queryFn: () =>
      api.call<{ id: string; displayName: string }[]>(
        "GET",
        "/core/users?limit=100",
      ),
  }).data;
  const [showResolved, setShowResolved] = useState(false);
  const name = (id: string) =>
    id === me.id
      ? t("app.comments.you")
      : (users?.find((u) => u.id === id)?.displayName ?? "…");
  const run = (p: Promise<unknown>) =>
    p
      .then(() => queryClient.invalidateQueries({ queryKey: key }))
      .catch((e: Error) => {
        toast({ title: e.message, tone: "negative" });
        throw e;
      });
  const threads = comments.filter((c) => !c.parentId);
  const shown = threads.filter((c) => showResolved || !c.resolved);
  const resolvedCount = threads.filter((c) => c.resolved).length;

  return (
    <section
      aria-label={t("app.comments.title")}
      className="flex flex-col gap-4 border-t border-line pt-6"
    >
      <div className="flex items-center gap-2">
        <MessageSquare {...icon} className="text-fg-3" />
        <h2 className="flex-1 text-lg font-medium text-fg">
          {t("app.comments.title")}
        </h2>
        {resolvedCount > 0 && (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={showResolved}
            onClick={() => setShowResolved(!showResolved)}
          >
            {t("app.comments.resolvedToggle", { count: resolvedCount })}
          </Button>
        )}
      </div>
      {shown.map((thread) => (
        <article
          key={thread.id}
          className={`flex flex-col gap-3 rounded-md border border-line p-4 ${thread.resolved ? "opacity-70" : ""}`}
        >
          {thread.anchor && (
            <button
              type="button"
              className="border-l-2 border-accent pl-3 text-left text-sm text-fg-2 italic hover:text-fg"
              onClick={() => {
                if (!revealQuote(editor, thread.anchor!.quote))
                  toast({ title: t("app.comments.quoteGone") });
              }}
            >
              „{thread.anchor.quote}“
            </button>
          )}
          {[thread, ...comments.filter((c) => c.parentId === thread.id)].map(
            (c) => (
              <div key={c.id} className="flex flex-col gap-1">
                <p className="flex items-center gap-2 text-sm">
                  <span className="font-medium text-fg">
                    {name(c.authorId)}
                  </span>
                  <span className="text-fg-3">
                    {new Date(c.createdAt).toLocaleString()}
                  </span>
                  {c.authorId === me.id && (
                    <button
                      type="button"
                      className="text-fg-3 hover:text-fg"
                      onClick={() =>
                        void run(call("DELETE", `/comments/${c.id}`))
                      }
                    >
                      {t("app.comments.delete")}
                    </button>
                  )}
                </p>
                <RichTextView doc={c.body as never} />
              </div>
            ),
          )}
          <div className="flex flex-wrap items-start gap-2">
            {(canResolve || thread.authorId === me.id) && (
              <Button
                size="sm"
                onClick={() =>
                  void run(
                    call("PATCH", `/comments/${thread.id}`, {
                      resolved: !thread.resolved,
                    }),
                  )
                }
              >
                {thread.resolved
                  ? t("app.comments.reopen")
                  : t("app.comments.resolve")}
              </Button>
            )}
          </div>
          {canComment && !thread.resolved && (
            <Composer
              label={t("app.comments.reply")}
              onSend={(body) =>
                run(
                  call("POST", `/pages/${pageId}/comments`, {
                    body,
                    parentId: thread.id,
                  }),
                )
              }
            />
          )}
        </article>
      ))}
      {canComment && (
        <div className="flex flex-col gap-2">
          {quote && (
            <p className="flex items-center gap-2 border-l-2 border-accent pl-3 text-sm text-fg-2 italic">
              <span className="flex-1">„{quote}“</span>
              <button
                type="button"
                className="not-italic text-fg-3 hover:text-fg"
                onClick={onQuoteUsed}
              >
                {t("app.comments.dropQuote")}
              </button>
            </p>
          )}
          <Composer
            autoFocusKey={quote ?? ""}
            label={quote ? t("app.comments.onPassage") : t("app.comments.new")}
            onSend={(body) =>
              run(
                call("POST", `/pages/${pageId}/comments`, {
                  body,
                  anchor: quote ? { quote } : null,
                }),
              ).then(onQuoteUsed)
            }
          />
        </div>
      )}
    </section>
  );
}
