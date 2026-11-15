// Inserting a query block: a saved query or SQL, from Tickvana's or Nuvenna'
// tables, shown as table, number or bars. Runs as each reader, later.
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  Field,
  QueryView,
  Select,
  Textarea,
  type QueryBlockAttrs,
} from "@tvn/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function QueryDialog({
  onClose,
  onInsert,
}: {
  onClose: () => void;
  onInsert: (attrs: QueryBlockAttrs) => void;
}) {
  const { t } = useTranslation();
  const [attrs, setAttrs] = useState<QueryBlockAttrs>({
    app: "tickvana",
    queryId: "",
    sql: "",
    view: "table",
  });
  const [preview, setPreview] = useState<QueryBlockAttrs | null>(null);
  const saved =
    useQuery({
      queryKey: ["saved-queries", attrs.app],
      retry: false,
      queryFn: async () => {
        const res = await fetch(`/${attrs.app}/api/core/queries`, {
          credentials: "same-origin",
        });
        return res.ok
          ? ((await res.json()) as { id: string; name: string }[])
          : [];
      },
    }).data ?? [];
  const set = (patch: Partial<QueryBlockAttrs>) => {
    setAttrs({ ...attrs, ...patch });
    setPreview(null);
  };
  const ready = !!(attrs.queryId || attrs.sql.trim());
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("app.queryBlock.title")}
      description={t("app.queryBlock.hint")}
      closeLabel={t("shell.close")}
      footer={
        <>
          <Button onClick={() => setPreview(attrs)} disabled={!ready}>
            {t("app.queryBlock.preview")}
          </Button>
          <Button onClick={onClose}>{t("app.cancel")}</Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => {
              onInsert(attrs);
              onClose();
            }}
          >
            {t("app.insert")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        <div className="grid grid-cols-2 gap-4">
          <Field label={t("app.queryBlock.app")}>
            {(p) => (
              <Select
                id={p.id}
                value={attrs.app}
                onValueChange={(app) =>
                  set({ app: app as QueryBlockAttrs["app"], queryId: "" })
                }
                options={[
                  { value: "tickvana", label: t("app.queryBlock.track") },
                  { value: "nuvenna", label: t("app.queryBlock.pages") },
                ]}
              />
            )}
          </Field>
          <Field label={t("app.queryBlock.view")}>
            {(p) => (
              <Select
                id={p.id}
                value={attrs.view}
                onValueChange={(view) =>
                  set({ view: view as QueryBlockAttrs["view"] })
                }
                options={(["table", "number", "bar"] as const).map((v) => ({
                  value: v,
                  label: t(`app.queryBlock.views.${v}`),
                }))}
              />
            )}
          </Field>
        </div>
        <Field label={t("app.queryBlock.saved")}>
          {(p) => (
            <Select
              id={p.id}
              value={attrs.queryId || "none"}
              onValueChange={(id) =>
                set({ queryId: id === "none" ? "" : id, sql: "" })
              }
              options={[
                { value: "none", label: t("app.queryBlock.ownSql") },
                ...saved.map((q) => ({ value: q.id, label: q.name })),
              ]}
            />
          )}
        </Field>
        {!attrs.queryId && (
          <Field label="SQL">
            {(p) => (
              <Textarea
                {...p}
                rows={5}
                className="font-mono"
                placeholder="select status, count(*) as n from issues group by status"
                value={attrs.sql}
                onChange={(e) => set({ sql: e.target.value })}
              />
            )}
          </Field>
        )}
        {preview && (
          <div className="max-h-72 overflow-auto rounded-md border border-line">
            <QueryView {...preview} />
          </div>
        )}
      </div>
    </Dialog>
  );
}
