// Small things around pages: the bar with watch, favourite, like and labels;
// favourites and recently visited pages; a space's blog.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button, Card, Input, IssueCard, useToast } from "@tvn/ui";
import { Eye, EyeOff, Heart, Star, Tag } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePagesApi } from "./spaces.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

interface Meta {
  labels: string[];
  watching: boolean;
  favorite: boolean;
  liked: boolean;
  likes: number;
}

export function PageBar({
  pageId,
  canEdit,
}: {
  pageId: string;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const call = usePagesApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ["page-meta", pageId];
  const meta = useQuery({
    queryKey: key,
    queryFn: () => call<Meta>("GET", `/pages/${pageId}/meta`),
  }).data;
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    void call("POST", `/pages/${pageId}/visit`).catch(() => undefined);
  }, [pageId, call]);
  if (!meta) return null;
  const toggle = (path: "watch" | "favorite" | "like", on: boolean) =>
    void call(on ? "DELETE" : "PUT", `/pages/${pageId}/${path}`)
      .then(() => queryClient.invalidateQueries({ queryKey: key }))
      .catch((e: Error) => toast({ title: e.message, tone: "negative" }));
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={meta.watching}
        onClick={() => toggle("watch", meta.watching)}
      >
        {meta.watching ? <EyeOff {...icon} /> : <Eye {...icon} />}
        {meta.watching ? t("app.unwatch") : t("app.watch")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={meta.favorite}
        onClick={() => toggle("favorite", meta.favorite)}
      >
        <Star
          {...icon}
          className={meta.favorite ? "fill-current text-accent" : ""}
        />
        {t("app.favorite")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={meta.liked}
        onClick={() => toggle("like", meta.liked)}
      >
        <Heart
          {...icon}
          className={meta.liked ? "fill-current text-negative" : ""}
        />
        {meta.likes}
      </Button>
      <span className="flex items-center gap-1">
        <Tag {...icon} className="text-fg-3" />
        {editing === null ? (
          <>
            {meta.labels.map((l) => (
              <Link
                key={l}
                to="/labels/$label"
                params={{ label: l }}
                className="rounded-md border border-line px-2 text-fg-2 hover:text-fg"
              >
                {l}
              </Link>
            ))}
            {canEdit && (
              <button
                type="button"
                className="text-fg-3 hover:text-fg"
                onClick={() => setEditing(meta.labels.join(" "))}
              >
                {meta.labels.length ? t("app.editLabels") : t("app.addLabels")}
              </button>
            )}
          </>
        ) : (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void call("PUT", `/pages/${pageId}/labels`, {
                labels: editing.split(/[\s,]+/).filter(Boolean),
              })
                .then(() => {
                  setEditing(null);
                  return queryClient.invalidateQueries({ queryKey: key });
                })
                .catch((err: Error) =>
                  toast({ title: err.message, tone: "negative" }),
                );
            }}
          >
            <div className="w-56">
              <Input
                aria-label={t("app.labels")}
                autoFocus
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
              />
            </div>
            <Button size="sm" type="submit">
              {t("app.save")}
            </Button>
          </form>
        )}
      </span>
    </div>
  );
}

interface Listed {
  id: string;
  spaceKey: string;
  title: string;
  updatedAt: string;
}

function PageList({ title, path }: { title: string; path: string }) {
  const call = usePagesApi();
  const list = useQuery({
    queryKey: ["list", path],
    queryFn: () => call<Listed[]>("GET", path),
  }).data;
  if (!list?.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-fg-2">{title}</h2>
      <Card>
        <ul className="divide-y divide-line">
          {list.slice(0, 10).map((p) => (
            <li key={p.id}>
              <Link
                to="/spaces/$key/pages/$id"
                params={{ key: p.spaceKey, id: p.id }}
                className="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-raised"
              >
                <span className="w-16 font-mono text-xs text-fg-3">
                  {p.spaceKey}
                </span>
                <span className="flex-1 truncate text-fg">{p.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

/** Favourites and recently visited pages, for the start page. */
export function MyPages() {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PageList title={t("app.favorites")} path="/me/favorites" />
      <PageList title={t("app.recent")} path="/me/recent" />
    </div>
  );
}

/** Pages with one label, across all spaces the reader may see. */
export function LabelPage({ label }: { label: string }) {
  const { t } = useTranslation();
  return (
    <PageList
      title={t("app.withLabel", { label })}
      path={`/labels/${encodeURIComponent(label)}`}
    />
  );
}

export function Blog({
  spaceKey,
  canWrite,
}: {
  spaceKey: string;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const call = usePagesApi();
  const navigate = useNavigate();
  const toast = useToast();
  const posts = useQuery({
    queryKey: ["blog", spaceKey],
    queryFn: () =>
      call<{ id: string; title: string; excerpt: string; createdAt: string }[]>(
        "GET",
        `/spaces/${spaceKey}/blog`,
      ),
  }).data;
  const [title, setTitle] = useState("");
  return (
    <div className="flex flex-col gap-4">
      {canWrite && (
        <form
          className="flex max-w-xl gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void call<{ id: string }>("POST", `/spaces/${spaceKey}/pages`, {
              title,
              kind: "blog",
            })
              .then((p) =>
                navigate({
                  to: "/spaces/$key/pages/$id",
                  params: { key: spaceKey, id: p.id },
                }),
              )
              .catch((err: Error) =>
                toast({ title: err.message, tone: "negative" }),
              );
          }}
        >
          <Input
            aria-label={t("app.newPost")}
            placeholder={t("app.newPost")}
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button type="submit">{t("app.write")}</Button>
        </form>
      )}
      {posts?.length === 0 && (
        <p className="text-sm text-fg-3">{t("app.noPosts")}</p>
      )}
      {posts?.map((p) => (
        <article key={p.id} className="flex flex-col gap-1">
          <Link
            to="/spaces/$key/pages/$id"
            params={{ key: spaceKey, id: p.id }}
            className="text-lg font-medium text-fg underline-offset-4 hover:underline"
          >
            {p.title}
          </Link>
          <time className="text-sm text-fg-3" dateTime={p.createdAt}>
            {new Date(p.createdAt).toLocaleDateString()}
          </time>
          {p.excerpt && <p className="text-fg-2">{p.excerpt}</p>}
        </article>
      ))}
    </div>
  );
}

/** Tickets linked with the page, either way; each loads from Tickvana as the reader. */
export function LinkedIssues({ pageId }: { pageId: string }) {
  const { t } = useTranslation();
  const call = usePagesApi();
  const keys = useQuery({
    queryKey: ["page-issues", pageId],
    queryFn: () => call<{ keys: string[] }>("GET", `/pages/${pageId}/issues`),
  }).data?.keys;
  if (!keys?.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-fg-2">{t("app.linkedIssues")}</h2>
      <ul className="flex flex-col gap-2">
        {keys.map((k) => (
          <li key={k}>
            <IssueCard issueKey={k} />
          </li>
        ))}
      </ul>
    </section>
  );
}
