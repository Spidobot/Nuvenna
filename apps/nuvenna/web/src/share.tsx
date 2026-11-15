// Public links: the dialog where space administrators make and revoke them,
// and the page a reader without an account sees.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  RichTextView,
  useToast,
} from "@tvn/ui";
import type { RichDoc } from "@tvn/core/richtext";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePagesApi } from "./spaces.js";

interface Share {
  id: string;
  expiresAt: string | null;
  createdAt: string;
}

export function ShareDialog({
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
  const key = ["shares", pageId];
  const shares = useQuery({
    queryKey: key,
    queryFn: () => call<Share[]>("GET", `/pages/${pageId}/shares`),
  }).data;
  const [expires, setExpires] = useState("");
  const [made, setMade] = useState<string | null>(null);
  const fail = (e: Error) => toast({ title: e.message, tone: "negative" });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const date = (iso: string) => new Date(iso).toLocaleDateString();
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("app.share.title")}
      description={t("app.share.hint")}
      closeLabel={t("shell.close")}
    >
      <div className="flex flex-col gap-4 pb-2">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void call<Share & { url: string }>(
              "POST",
              `/pages/${pageId}/shares`,
              {
                // End of the chosen day, in the reader's time zone.
                expiresAt: expires
                  ? new Date(`${expires}T23:59:59`).toISOString()
                  : null,
              },
            )
              .then((s) => {
                setMade(s.url);
                setExpires("");
                return refresh();
              })
              .catch(fail);
          }}
        >
          <div className="flex-1">
            <Field label={t("app.share.expires")} hint={t("app.share.never")}>
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                />
              )}
            </Field>
          </div>
          <Button variant="primary" type="submit">
            {t("app.share.create")}
          </Button>
        </form>
        {made && (
          <div className="flex flex-col gap-2 rounded-md border border-line p-3">
            <p className="text-sm text-fg-2">{t("app.share.once")}</p>
            <div className="flex gap-2">
              <Input
                readOnly
                aria-label={t("app.share.link")}
                value={made}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                onClick={() =>
                  void navigator.clipboard
                    .writeText(made)
                    .then(() => toast({ title: t("app.share.copied") }))
                }
              >
                {t("app.share.copy")}
              </Button>
            </div>
          </div>
        )}
        {shares?.length ? (
          <ul className="flex flex-col divide-y divide-line text-sm">
            {shares.map((s) => (
              <li key={s.id} className="flex items-center gap-2 py-2">
                <span className="flex-1 text-fg">
                  {t("app.share.since", { date: date(s.createdAt) })}
                  {" · "}
                  {s.expiresAt
                    ? t("app.share.until", { date: date(s.expiresAt) })
                    : t("app.share.noEnd")}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void call("DELETE", `/pages/${pageId}/shares/${s.id}`)
                      .then(refresh)
                      .catch(fail)
                  }
                >
                  {t("app.share.revoke")}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-3">{t("app.share.none")}</p>
        )}
      </div>
    </Dialog>
  );
}

/** What someone with a public link sees: the page, nothing around it. */
export function SharedPage() {
  const { t } = useTranslation();
  const token = window.location.hash.slice(1);
  const page = useQuery({
    queryKey: ["shared", token],
    enabled: !!token,
    queryFn: async () => {
      const res = await fetch("/nuvenna/api/shared", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as {
        title: string;
        content: RichDoc;
        updatedAt: string;
      };
    },
  });
  if (!token || page.isError)
    return (
      <main className="mx-auto max-w-3xl p-6">
        <EmptyState
          title={t("app.share.gone")}
          text={t("app.share.goneText")}
        />
      </main>
    );
  if (!page.data) return null;
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-medium text-fg">{page.data.title}</h1>
      <p className="text-sm text-fg-3">
        {t("app.share.updated", {
          date: new Date(page.data.updatedAt).toLocaleDateString(),
        })}
      </p>
      <RichTextView doc={page.data.content} />
    </main>
  );
}
