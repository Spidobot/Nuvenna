// Spaces and their page tree: list, create, and per space the tree with
// adding, renaming, moving, copying, trash and restore.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Field as FormField,
  IconButton,
  Input,
  Menu,
  Select,
  Tabs,
  useApp,
  useToast,
} from "@tvn/ui";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  MoreHorizontal,
  Plus,
  Upload,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { Blog, MyPages } from "./extras.js";
import { SpaceSettings } from "./space-settings.js";
import { useTranslation } from "react-i18next";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

export interface Space {
  id: string;
  key: string;
  name: string;
  description: string;
  homePageId: string | null;
  archived: boolean;
  knowledgeBase: boolean;
  rights: string[];
}
export interface TreeNode {
  id: string;
  parentId: string | null;
  position: number;
  title: string;
  kind: string;
}

export function usePagesApi() {
  const { api } = useApp();
  return api.call;
}
export const useSpaces = () => {
  const call = usePagesApi();
  return useQuery({
    queryKey: ["spaces"],
    queryFn: () => call<Space[]>("GET", "/spaces"),
  });
};
export const useSpace = (key: string) => {
  const call = usePagesApi();
  return useQuery({
    queryKey: ["space", key],
    queryFn: () => call<Space>("GET", `/spaces/${key}`),
  });
};
export const useTree = (key: string) => {
  const call = usePagesApi();
  return useQuery({
    queryKey: ["tree", key],
    queryFn: () => call<TreeNode[]>("GET", `/spaces/${key}/tree`),
  });
};

function useRun() {
  const toast = useToast();
  const queryClient = useQueryClient();
  return (promise: Promise<unknown>, ...keys: unknown[][]) =>
    promise
      .then(() =>
        Promise.all(
          keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        ),
      )
      .catch((e: Error) => {
        toast({ title: e.message, tone: "negative" });
        throw e;
      });
}

/** A one-field dialog: name a new space or page, or rename one. */
function NameDialog({
  title,
  initial = "",
  withKey = false,
  templatesOf,
  onClose,
  onSave,
}: {
  title: string;
  initial?: string;
  withKey?: boolean;
  /** Offer the templates of this space to start from. */
  templatesOf?: string;
  onClose: () => void;
  onSave: (name: string, key: string, templateId?: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const call = usePagesApi();
  const [name, setName] = useState(initial);
  const [key, setKey] = useState("");
  const [template, setTemplate] = useState("");
  const templates = useQuery({
    queryKey: ["templates", templatesOf],
    enabled: !!templatesOf,
    queryFn: () =>
      call<{ id: string; title: string }[]>(
        "GET",
        `/spaces/${templatesOf}/templates`,
      ),
  }).data;
  const [busy, setBusy] = useState(false);
  const suggested = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    void onSave(name, key || suggested, template || undefined)
      .then(onClose)
      .catch(() => setBusy(false));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      closeLabel={t("shell.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("app.cancel")}</Button>
          <Button
            variant="primary"
            type="submit"
            form="name-form"
            disabled={busy}
          >
            {t("app.save")}
          </Button>
        </>
      }
    >
      <form
        id="name-form"
        className="flex flex-col gap-4 pb-2"
        onSubmit={submit}
      >
        <FormField label={t("app.name")}>
          {(p) => (
            <Input
              {...p}
              required
              maxLength={500}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </FormField>
        {templates && (
          <FormField label={t("app.template")}>
            {(p) => (
              <Select
                id={p.id}
                value={template || "none"}
                onValueChange={(v) => setTemplate(v === "none" ? "" : v)}
                options={[
                  { value: "none", label: t("app.blankPage") },
                  ...templates.map((x) => ({ value: x.id, label: x.title })),
                ]}
              />
            )}
          </FormField>
        )}
        {withKey && (
          <FormField label={t("app.key")} hint={t("app.keyHint")}>
            {(p) => (
              <Input
                {...p}
                pattern="[A-Za-z][A-Za-z0-9]{1,19}"
                value={key || suggested}
                onChange={(e) => setKey(e.target.value)}
              />
            )}
          </FormField>
        )}
      </form>
    </Dialog>
  );
}

export function SpacesPage() {
  const { t } = useTranslation();
  const call = usePagesApi();
  const run = useRun();
  const navigate = useNavigate();
  const spaces = useSpaces();
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Plus {...icon} />
          {t("app.newSpace")}
        </Button>
      </div>
      <MyPages />
      {spaces.data?.length === 0 ? (
        <EmptyState title={t("app.emptyTitle")} text={t("app.emptyText")} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {spaces.data?.map((s) => (
            <Link key={s.id} to="/spaces/$key" params={{ key: s.key }}>
              <Card className="flex h-full flex-col gap-1 p-4 transition-colors hover:bg-raised">
                <span className="font-mono text-xs text-fg-3">{s.key}</span>
                <span className="text-base font-medium text-fg">{s.name}</span>
                {s.description && (
                  <span className="text-sm text-fg-2">{s.description}</span>
                )}
                {s.archived && (
                  <span className="text-sm text-fg-3">{t("app.archived")}</span>
                )}
              </Card>
            </Link>
          ))}
        </div>
      )}
      {creating && (
        <NameDialog
          title={t("app.newSpace")}
          withKey
          onClose={() => setCreating(false)}
          onSave={(name, key) =>
            run(call<Space>("POST", "/spaces", { name, key }), ["spaces"]).then(
              () =>
                void navigate({
                  to: "/spaces/$key",
                  params: { key: key.toUpperCase() },
                }),
            )
          }
        />
      )}
    </div>
  );
}

/** One level of the tree, with its children when open. */
function Branch({
  spaceKey,
  nodes,
  parentId,
  depth,
  canEdit,
}: {
  spaceKey: string;
  nodes: TreeNode[];
  parentId: string | null;
  depth: number;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const call = usePagesApi();
  const run = useRun();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<{
    kind: "add" | "rename";
    node: TreeNode;
  } | null>(null);
  const level = nodes
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.position - b.position);
  const keys = [["tree", spaceKey]];
  const move = (n: TreeNode, body: object) =>
    void run(call("POST", `/pages/${n.id}/move`, body), ...keys);
  return (
    <ul className="flex flex-col">
      {level.map((n, i) => {
        const hasChildren = nodes.some((c) => c.parentId === n.id);
        const isOpen = open[n.id] ?? depth === 0;
        return (
          <li key={n.id}>
            <div
              className="group flex items-center gap-1 rounded-md pr-1 hover:bg-raised"
              style={{ paddingLeft: `calc(var(--spacing) * ${depth * 4})` }}
            >
              <button
                type="button"
                aria-label={isOpen ? t("app.collapse") : t("app.expand")}
                aria-expanded={hasChildren ? isOpen : undefined}
                className={hasChildren ? "p-1 text-fg-3" : "invisible p-1"}
                onClick={() => setOpen({ ...open, [n.id]: !isOpen })}
              >
                {isOpen ? (
                  <ChevronDown {...icon} />
                ) : (
                  <ChevronRight {...icon} />
                )}
              </button>
              <FileText {...icon} className="text-fg-3" />
              <Link
                to="/spaces/$key/pages/$id"
                params={{ key: spaceKey, id: n.id }}
                className="flex-1 truncate py-1 text-sm text-fg"
                activeProps={{ className: "font-medium" }}
              >
                {n.title}
              </Link>
              {canEdit && (
                <Menu
                  trigger={
                    <IconButton
                      label={`${t("app.actions")}: ${n.title}`}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <MoreHorizontal {...icon} />
                    </IconButton>
                  }
                  items={[
                    {
                      label: t("app.addChild"),
                      onSelect: () => setDialog({ kind: "add", node: n }),
                    },
                    {
                      label: t("app.rename"),
                      onSelect: () => setDialog({ kind: "rename", node: n }),
                    },
                    {
                      label: t("app.moveUp"),
                      disabled: i === 0,
                      onSelect: () => move(n, { parentId, position: i - 1 }),
                    },
                    {
                      label: t("app.moveDown"),
                      disabled: i === level.length - 1,
                      onSelect: () => move(n, { parentId, position: i + 1 }),
                    },
                    {
                      label: t("app.indent"),
                      disabled: i === 0,
                      onSelect: () =>
                        move(n, { parentId: level[i - 1]!.id, position: null }),
                    },
                    {
                      label: t("app.outdent"),
                      disabled: parentId === null,
                      onSelect: () => {
                        const parent = nodes.find((x) => x.id === parentId);
                        move(n, {
                          parentId: parent?.parentId ?? null,
                          position: (parent?.position ?? 0) + 1,
                        });
                      },
                    },
                    {
                      label: t("app.copy"),
                      onSelect: () =>
                        void run(
                          call("POST", `/pages/${n.id}/copy`, {
                            parentId,
                            title: `${n.title} ${t("app.copySuffix")}`,
                          }),
                          ...keys,
                        ),
                    },
                    {
                      label: t("app.toTrash"),
                      onSelect: () =>
                        void run(call("DELETE", `/pages/${n.id}`), ...keys, [
                          "trash",
                          spaceKey,
                        ]),
                    },
                  ]}
                />
              )}
            </div>
            {hasChildren && isOpen && (
              <Branch
                spaceKey={spaceKey}
                nodes={nodes}
                parentId={n.id}
                depth={depth + 1}
                canEdit={canEdit}
              />
            )}
          </li>
        );
      })}
      {dialog && (
        <NameDialog
          title={dialog.kind === "add" ? t("app.newPage") : t("app.rename")}
          initial={dialog.kind === "rename" ? dialog.node.title : ""}
          templatesOf={dialog.kind === "add" ? spaceKey : undefined}
          onClose={() => setDialog(null)}
          onSave={(title, _key, templateId) =>
            dialog.kind === "add"
              ? run(
                  call("POST", `/spaces/${spaceKey}/pages`, {
                    title,
                    templateId,
                    parentId: dialog.node.id,
                  }),
                  ...keys,
                ).then(() => setOpen({ ...open, [dialog.node.id]: true }))
              : run(
                  call("PATCH", `/pages/${dialog.node.id}`, { title }),
                  ...keys,
                  ["page", dialog.node.id],
                )
          }
        />
      )}
    </ul>
  );
}

/** The tree of a space, for the left column of every page in it. */
export function SpaceTree({ spaceKey }: { spaceKey: string }) {
  const { t } = useTranslation();
  const call = usePagesApi();
  const run = useRun();
  const space = useSpace(spaceKey).data;
  const tree = useTree(spaceKey).data;
  const [adding, setAdding] = useState(false);
  if (!space || !tree) return null;
  const canEdit = space.rights.includes("space.edit");
  return (
    <nav aria-label={t("app.pageTree")} className="flex flex-col gap-2">
      <Branch
        spaceKey={spaceKey}
        nodes={tree}
        parentId={null}
        depth={0}
        canEdit={canEdit}
      />
      {canEdit && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus {...icon} />
            {t("app.newPage")}
          </Button>
        </div>
      )}
      {adding && (
        <NameDialog
          title={t("app.newPage")}
          templatesOf={spaceKey}
          onClose={() => setAdding(false)}
          onSave={(title, _key, templateId) =>
            run(
              call("POST", `/spaces/${spaceKey}/pages`, {
                title,
                templateId,
                parentId: space.homePageId,
              }),
              ["tree", spaceKey],
            )
          }
        />
      )}
    </nav>
  );
}

function Trash({
  spaceKey,
  canPurge,
}: {
  spaceKey: string;
  canPurge: boolean;
}) {
  const { t } = useTranslation();
  const call = usePagesApi();
  const run = useRun();
  const trash = useQuery({
    queryKey: ["trash", spaceKey],
    queryFn: () =>
      call<(TreeNode & { trashedAt: string })[]>(
        "GET",
        `/spaces/${spaceKey}/trash`,
      ),
  }).data;
  if (!trash?.length)
    return <p className="text-sm text-fg-3">{t("app.trashEmpty")}</p>;
  return (
    <Card>
      <ul className="divide-y divide-line">
        {trash.map((p) => (
          <li key={p.id} className="flex items-center gap-2 px-4 py-2">
            <span className="flex-1 text-fg">{p.title}</span>
            <span className="text-sm text-fg-3">
              {new Date(p.trashedAt).toLocaleString()}
            </span>
            <Button
              size="sm"
              onClick={() =>
                void run(
                  call("POST", `/pages/${p.id}/restore`),
                  ["trash", spaceKey],
                  ["tree", spaceKey],
                )
              }
            >
              {t("app.restore")}
            </Button>
            {canPurge && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void run(call("DELETE", `/pages/${p.id}/purge`), [
                    "trash",
                    spaceKey,
                  ])
                }
              >
                {t("app.purge")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The space's own templates; the built-in ones are only offered when adding. */
function Templates({
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
  const [adding, setAdding] = useState(false);
  const own = useQuery({
    queryKey: ["templates", spaceKey],
    queryFn: () =>
      call<{ id: string; title: string }[]>(
        "GET",
        `/spaces/${spaceKey}/templates`,
      ),
  }).data?.filter((x) => !x.id.startsWith("builtin:"));
  return (
    <div className="flex flex-col gap-4">
      {canWrite && (
        <div>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus {...icon} />
            {t("app.newTemplate")}
          </Button>
        </div>
      )}
      {own?.length === 0 && (
        <p className="text-sm text-fg-3">{t("app.noTemplates")}</p>
      )}
      {!!own?.length && (
        <Card>
          <ul className="divide-y divide-line">
            {own.map((x) => (
              <li key={x.id}>
                <Link
                  to="/spaces/$key/pages/$id"
                  params={{ key: spaceKey, id: x.id }}
                  className="block px-4 py-2 text-fg transition-colors hover:bg-raised"
                >
                  {x.title}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {adding && (
        <NameDialog
          title={t("app.newTemplate")}
          templatesOf={spaceKey}
          onClose={() => setAdding(false)}
          onSave={(title, _key, templateId) =>
            call<{ id: string }>("POST", `/spaces/${spaceKey}/pages`, {
              title,
              kind: "template",
              templateId,
            })
              .then((p) =>
                navigate({
                  to: "/spaces/$key/pages/$id",
                  params: { key: spaceKey, id: p.id },
                }),
              )
              .catch((e: Error) => {
                toast({ title: e.message, tone: "negative" });
                throw e;
              })
          }
        />
      )}
    </div>
  );
}

/** Export as a ZIP of Markdown or HTML; import a folder of Markdown files. */
function SpaceTransfer({
  spaceKey,
  canImport,
}: {
  spaceKey: string;
  canImport: boolean;
}) {
  const { t } = useTranslation();
  const call = usePagesApi();
  const run = useRun();
  const toast = useToast();
  const pick = (input: HTMLInputElement) => {
    const chosen = [...(input.files ?? [])].filter((f) =>
      /\.(md|markdown)$/i.test(f.name),
    );
    input.value = "";
    if (!chosen.length)
      return toast({ title: t("app.importNothing"), tone: "negative" });
    void Promise.all(
      chosen.map(async (f) => ({
        path: f.webkitRelativePath || f.name,
        content: await f.text(),
      })),
    ).then((files) =>
      run(
        call<{ created: number }>("POST", `/spaces/${spaceKey}/import`, {
          files,
        }).then((r) =>
          toast({ title: t("app.imported", { count: r.created }) }),
        ),
        ["tree", spaceKey],
      ).catch(() => undefined),
    );
  };
  return (
    <div className="flex gap-2">
      <Menu
        trigger={
          <Button size="sm">
            <Download {...icon} />
            {t("app.export")}
          </Button>
        }
        items={(["markdown", "html"] as const).map((format) => ({
          label: t(`app.exportAs.${format}`),
          onSelect: () =>
            window.location.assign(
              `/nuvenna/api/spaces/${spaceKey}/export?format=${format}`,
            ),
        }))}
      />
      {canImport && (
        <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line-strong px-3 text-sm text-fg transition-colors hover:bg-raised focus-within:outline-2 focus-within:outline-accent">
          <Upload {...icon} />
          {t("app.importFolder")}
          <input
            type="file"
            className="sr-only"
            multiple
            {...{ webkitdirectory: "" }}
            onChange={(e) => pick(e.currentTarget)}
          />
        </label>
      )}
    </div>
  );
}

/** A space: its description, tree and trash. */
export function SpacePage() {
  const { t } = useTranslation();
  const { key } = useParams({ from: "/spaces/$key" });
  const space = useSpace(key);
  if (space.isError) return <EmptyState title={t("app.notFound")} text="" />;
  if (!space.data) return null;
  const s = space.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex flex-1 flex-col gap-1">
          <h2 className="text-2xl font-medium text-fg">{s.name}</h2>
          {s.description && <p className="text-fg-2">{s.description}</p>}
        </div>
        <SpaceTransfer
          spaceKey={key}
          canImport={s.rights.includes("space.edit")}
        />
      </div>
      <Tabs
        label={s.name}
        tabs={[
          {
            value: "tree",
            label: t("app.pageTree"),
            content: <SpaceTree spaceKey={key} />,
          },
          {
            value: "blog",
            label: t("app.blog"),
            content: (
              <Blog spaceKey={key} canWrite={s.rights.includes("space.edit")} />
            ),
          },
          {
            value: "templates",
            label: t("app.templates"),
            content: (
              <Templates
                spaceKey={key}
                canWrite={s.rights.includes("space.edit")}
              />
            ),
          },
          ...(s.rights.includes("space.administer")
            ? [
                {
                  value: "settings",
                  label: t("app.admin.settings"),
                  content: <SpaceSettings space={s} />,
                },
              ]
            : []),
          ...(s.rights.includes("space.delete")
            ? [
                {
                  value: "trash",
                  label: t("app.trash"),
                  content: (
                    <Trash
                      spaceKey={key}
                      canPurge={s.rights.includes("space.administer")}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}
