// Space administration (name, home page, archive, rights) and the
// restrictions of one page.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Dialog, Field, Input, Select, useToast } from "@tvn/ui";
import { X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePagesApi, useTree, type Space } from "./spaces.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;
const PERMISSIONS = [
  "space.view",
  "space.comment",
  "space.edit",
  "space.delete",
  "space.administer",
] as const;

interface Who {
  type: string;
  id: string | null;
}

/** Users and groups to choose from. Staff may list both. */
function usePeople() {
  const call = usePagesApi();
  const users =
    useQuery({
      queryKey: ["people", "users"],
      queryFn: () =>
        call<{ id: string; displayName: string }[]>(
          "GET",
          "/core/users?kind=internal&limit=100",
        ),
    }).data ?? [];
  const groups =
    useQuery({
      queryKey: ["people", "groups"],
      queryFn: () =>
        call<{ id: string; name: string }[]>("GET", "/core/groups"),
    }).data ?? [];
  return { users, groups };
}

function WhoPicker({
  types,
  value,
  onChange,
}: {
  types: string[];
  value: Who;
  onChange: (value: Who) => void;
}) {
  const { t } = useTranslation();
  const { users, groups } = usePeople();
  const named = value.type === "user" || value.type === "group";
  return (
    <>
      <div className="w-40">
        <Select
          aria-label={t("app.admin.who")}
          value={value.type}
          onValueChange={(type) => onChange({ type, id: null })}
          options={types.map((x) => ({
            value: x,
            label: t(`app.admin.grantees.${x}`),
          }))}
        />
      </div>
      {named && (
        <div className="w-48">
          <Select
            aria-label={t(`app.admin.grantees.${value.type}`)}
            placeholder={t("app.admin.choose")}
            value={value.id ?? undefined}
            onValueChange={(id) => onChange({ ...value, id })}
            options={
              value.type === "user"
                ? users.map((u) => ({ value: u.id, label: u.displayName }))
                : groups.map((g) => ({ value: g.id, label: g.name }))
            }
          />
        </div>
      )}
    </>
  );
}

export function SpaceSettings({ space }: { space: Space }) {
  const { t } = useTranslation();
  const call = usePagesApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const tree = useTree(space.key).data ?? [];
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description);
  const [permission, setPermission] = useState<string>("space.view");
  const [who, setWho] = useState<Who>({ type: "user", id: null });
  const grantsKey = ["space-permissions", space.key];
  const grants =
    useQuery({
      queryKey: grantsKey,
      queryFn: () =>
        call<
          {
            id: string;
            permission: string;
            granteeType: string;
            name: string | null;
          }[]
        >("GET", `/spaces/${space.key}/permissions`),
    }).data ?? [];
  const fail = (e: Error) => toast({ title: e.message, tone: "negative" });
  const patch = (body: object) =>
    call("PATCH", `/spaces/${space.key}`, body)
      .then(() =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: ["space", space.key] }),
          queryClient.invalidateQueries({ queryKey: ["spaces"] }),
        ]),
      )
      .then(() => toast({ title: t("app.admin.saved") }))
      .catch(fail);
  const reloadGrants = () =>
    queryClient.invalidateQueries({ queryKey: grantsKey });

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <section className="flex flex-col gap-4">
        <h3 className="text-lg font-medium text-fg">
          {t("app.admin.general")}
        </h3>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void patch({ name, description });
          }}
        >
          <Field label={t("app.name")}>
            {(p) => (
              <Input
                {...p}
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label={t("app.admin.description")}>
            {(p) => (
              <Input
                {...p}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          <div>
            <Button type="submit" variant="primary">
              {t("app.save")}
            </Button>
          </div>
        </form>
        <Field label={t("app.admin.home")}>
          {(p) => (
            <Select
              id={p.id}
              value={space.homePageId ?? undefined}
              placeholder={t("app.admin.choose")}
              onValueChange={(homePageId) => void patch({ homePageId })}
              options={tree.map((n) => ({ value: n.id, label: n.title }))}
            />
          )}
        </Field>
        <div className="flex items-center gap-4">
          <p className="flex-1 text-sm text-fg-2">
            {space.archived
              ? t("app.admin.archivedText")
              : t("app.admin.archiveText")}
          </p>
          <Button onClick={() => void patch({ archived: !space.archived })}>
            {space.archived ? t("app.admin.unarchive") : t("app.admin.archive")}
          </Button>
        </div>
        <div className="flex items-center gap-4">
          <p className="flex-1 text-sm text-fg-2">
            {space.knowledgeBase
              ? t("app.admin.knowledgeOn", { key: space.key })
              : t("app.admin.knowledgeOff")}
          </p>
          <Button
            onClick={() => void patch({ knowledgeBase: !space.knowledgeBase })}
          >
            {space.knowledgeBase
              ? t("app.admin.knowledgeStop")
              : t("app.admin.knowledgeStart")}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h3 className="text-lg font-medium text-fg">{t("app.admin.rights")}</h3>
        <Card>
          <ul className="divide-y divide-line">
            {grants.map((g) => (
              <li
                key={g.id}
                className="flex items-center gap-4 px-4 py-2 text-sm"
              >
                <span className="w-40 text-fg-2">
                  {t(`app.admin.permissions.${g.permission}`)}
                </span>
                <span className="flex-1 text-fg">
                  {g.name ?? t(`app.admin.grantees.${g.granteeType}`)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("app.admin.remove")}
                  onClick={() =>
                    void call(
                      "DELETE",
                      `/spaces/${space.key}/permissions/${g.id}`,
                    )
                      .then(reloadGrants)
                      .catch(fail)
                  }
                >
                  <X {...icon} />
                </Button>
              </li>
            ))}
          </ul>
        </Card>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void call("POST", `/spaces/${space.key}/permissions`, {
              permission,
              granteeType: who.type,
              ...(who.id && { granteeId: who.id }),
            })
              .then(reloadGrants)
              .catch(fail);
          }}
        >
          <div className="w-44">
            <Select
              aria-label={t("app.admin.permission")}
              value={permission}
              onValueChange={setPermission}
              options={PERMISSIONS.map((p) => ({
                value: p,
                label: t(`app.admin.permissions.${p}`),
              }))}
            />
          </div>
          <WhoPicker
            types={["user", "group", "logged_in", "anyone"]}
            value={who}
            onChange={setWho}
          />
          <Button
            type="submit"
            disabled={(who.type === "user" || who.type === "group") && !who.id}
          >
            {t("app.admin.grant")}
          </Button>
        </form>
      </section>
    </div>
  );
}

type Entry = { type: string; id: string; name: string | null };

export function RestrictionsDialog({
  pageId,
  onClose,
}: {
  pageId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const call = usePagesApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { users, groups } = usePeople();
  const current = useQuery({
    queryKey: ["restrictions", pageId],
    queryFn: () =>
      call<{ view: Entry[]; edit: Entry[] }>(
        "GET",
        `/pages/${pageId}/restrictions`,
      ),
  }).data;
  const [draft, setDraft] = useState<{ view: Entry[]; edit: Entry[] } | null>(
    null,
  );
  const [adding, setAdding] = useState<Record<string, Who>>({
    view: { type: "user", id: null },
    edit: { type: "user", id: null },
  });
  const lists = draft ?? current;
  if (!lists) return null;
  const nameOf = (w: Who) =>
    w.type === "user"
      ? users.find((u) => u.id === w.id)?.displayName
      : groups.find((g) => g.id === w.id)?.name;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("app.restrict.title")}
      description={t("app.restrict.hint")}
      closeLabel={t("shell.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("app.cancel")}</Button>
          <Button
            variant="primary"
            onClick={() =>
              void call("PUT", `/pages/${pageId}/restrictions`, {
                view: lists.view.map(({ type, id }) => ({ type, id })),
                edit: lists.edit.map(({ type, id }) => ({ type, id })),
              })
                .then(() =>
                  Promise.all([
                    queryClient.invalidateQueries({
                      queryKey: ["restrictions", pageId],
                    }),
                    queryClient.invalidateQueries({ queryKey: ["tree"] }),
                  ]),
                )
                .then(onClose)
                .catch((e: Error) =>
                  toast({ title: e.message, tone: "negative" }),
                )
            }
          >
            {t("app.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6 pb-2">
        {(["view", "edit"] as const).map((kind) => (
          <section key={kind} className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-fg">
              {t(`app.restrict.${kind}`)}
            </h3>
            {lists[kind].length === 0 ? (
              <p className="text-sm text-fg-3">
                {t(`app.restrict.${kind}Open`)}
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {lists[kind].map((x) => (
                  <li
                    key={x.type + x.id}
                    className="flex items-center gap-1 rounded-md border border-line px-2 text-sm text-fg"
                  >
                    {x.name ?? x.id}
                    <button
                      type="button"
                      aria-label={`${t("app.admin.remove")}: ${x.name ?? x.id}`}
                      className="text-fg-3 hover:text-fg"
                      onClick={() =>
                        setDraft({
                          ...lists,
                          [kind]: lists[kind].filter((y) => y !== x),
                        })
                      }
                    >
                      <X {...icon} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <WhoPicker
                types={["user", "group"]}
                value={adding[kind]!}
                onChange={(w) => setAdding({ ...adding, [kind]: w })}
              />
              <Button
                size="sm"
                disabled={!adding[kind]!.id}
                onClick={() => {
                  const w = adding[kind]!;
                  setDraft({
                    ...lists,
                    [kind]: [
                      ...lists[kind],
                      { type: w.type, id: w.id!, name: nameOf(w) ?? null },
                    ],
                  });
                  setAdding({ ...adding, [kind]: { type: w.type, id: null } });
                }}
              >
                {t("app.restrict.add")}
              </Button>
            </div>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
