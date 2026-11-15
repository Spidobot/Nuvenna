// A ticket from marked text: created in Tickvana with the reader's cookie, then
// placed as a ticket block below the paragraph.
import { useQuery } from "@tanstack/react-query";
import { Button, Dialog, Field, Input, Select, useToast } from "@tvn/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";

const track = async <T,>(path: string, body?: object): Promise<T> => {
  const res = await fetch(`/tickvana/api${path}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body && JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    (T & { error?: { message: string } }) | null;
  if (!res.ok) throw new Error(data?.error?.message ?? String(res.status));
  return data as T;
};

export function NewTicketDialog({
  text,
  onClose,
  onCreated,
}: {
  text: string;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const projects = useQuery({
    queryKey: ["track-projects"],
    retry: false,
    queryFn: () =>
      track<{ key: string; name: string; archived: boolean }[]>("/projects"),
  });
  const [project, setProject] = useState<string>();
  const projectKey =
    project ?? projects.data?.find((p) => !p.archived)?.key ?? undefined;
  const types =
    useQuery({
      queryKey: ["track-project-types", projectKey],
      enabled: !!projectKey,
      retry: false,
      queryFn: () =>
        track<{ issueTypes: { id: string; name: string }[] }>(
          `/projects/${projectKey}`,
        ),
    }).data?.issueTypes ?? [];
  const [type, setType] = useState<string>();
  const typeId = type ?? types[0]?.id;
  const [summary, setSummary] = useState(text.slice(0, 255));
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("app.newTicket.title")}
      closeLabel={t("shell.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("app.cancel")}</Button>
          <Button
            variant="primary"
            type="submit"
            form="new-ticket-form"
            disabled={busy || !projectKey || !typeId}
          >
            {t("app.newTicket.create")}
          </Button>
        </>
      }
    >
      {projects.isError ? (
        <p className="pb-2 text-sm text-fg-3">{t("app.newTicket.noTrack")}</p>
      ) : (
        <form
          id="new-ticket-form"
          className="flex flex-col gap-4 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void track<{ key: string }>("/issues", {
              projectKey,
              type: typeId,
              fields: { summary },
            })
              .then((issue) => {
                onCreated(issue.key);
                onClose();
              })
              .catch((err: Error) => {
                setBusy(false);
                toast({ title: err.message, tone: "negative" });
              });
          }}
        >
          <div className="grid grid-cols-2 gap-4">
            <Field label={t("app.newTicket.project")}>
              {(p) => (
                <Select
                  id={p.id}
                  value={projectKey}
                  onValueChange={(v) => {
                    setProject(v);
                    setType(undefined);
                  }}
                  options={(projects.data ?? [])
                    .filter((x) => !x.archived)
                    .map((x) => ({ value: x.key, label: x.name }))}
                />
              )}
            </Field>
            <Field label={t("app.newTicket.type")}>
              {(p) => (
                <Select
                  id={p.id}
                  value={typeId}
                  onValueChange={setType}
                  options={types.map((x) => ({ value: x.id, label: x.name }))}
                />
              )}
            </Field>
          </div>
          <Field label={t("app.newTicket.summary")}>
            {(p) => (
              <Input
                {...p}
                required
                maxLength={255}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
            )}
          </Field>
        </form>
      )}
    </Dialog>
  );
}
