// Templates: pages of kind "template" in a space, plus four that come with
// Nuvenna. A new page can start from either.
import type { RichDoc, RichNode } from "@tvn/core";

const h = (level: number, text: string): RichNode => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});
const p = (text = ""): RichNode => ({
  type: "paragraph",
  ...(text && { content: [{ type: "text", text }] }),
});
const tasks = (...items: string[]): RichNode => ({
  type: "taskList",
  content: items.map((text) => ({
    type: "taskItem",
    attrs: { checked: false },
    content: [p(text)],
  })),
});
const bullets = (...items: string[]): RichNode => ({
  type: "bulletList",
  content: items.map((text) => ({ type: "listItem", content: [p(text)] })),
});
const callout = (kind: string, text: string): RichNode => ({
  type: "callout",
  attrs: { kind },
  content: [p(text)],
});
const doc = (...content: RichNode[]): RichDoc => ({ type: "doc", content });

type Lang = "de" | "en";
const BUILT_IN: Record<
  string,
  Record<Lang, { title: string; description: string; content: RichDoc }>
> = {
  meeting: {
    de: {
      title: "Besprechung",
      description: "Teilnehmende, Tagesordnung, Notizen und Aufgaben",
      content: doc(
        h(2, "Teilnehmende"),
        bullets(""),
        h(2, "Tagesordnung"),
        bullets(""),
        h(2, "Notizen"),
        p(),
        h(2, "Aufgaben"),
        tasks(""),
      ),
    },
    en: {
      title: "Meeting",
      description: "Attendees, agenda, notes and action items",
      content: doc(
        h(2, "Attendees"),
        bullets(""),
        h(2, "Agenda"),
        bullets(""),
        h(2, "Notes"),
        p(),
        h(2, "Action items"),
        tasks(""),
      ),
    },
  },
  decision: {
    de: {
      title: "Entscheidung",
      description: "Frage, Optionen, Entscheidung und Folgen",
      content: doc(
        callout("info", "Status: offen"),
        h(2, "Worum geht es?"),
        p(),
        h(2, "Optionen"),
        bullets("Option A", "Option B"),
        h(2, "Entscheidung"),
        p(),
        h(2, "Folgen"),
        p(),
      ),
    },
    en: {
      title: "Decision",
      description: "Question, options, decision and consequences",
      content: doc(
        callout("info", "Status: open"),
        h(2, "Context"),
        p(),
        h(2, "Options"),
        bullets("Option A", "Option B"),
        h(2, "Decision"),
        p(),
        h(2, "Consequences"),
        p(),
      ),
    },
  },
  howto: {
    de: {
      title: "Anleitung",
      description: "Schritt für Schritt, mit Voraussetzungen",
      content: doc(
        { type: "toc" },
        h(2, "Voraussetzungen"),
        bullets(""),
        h(2, "Schritte"),
        {
          type: "orderedList",
          content: [{ type: "listItem", content: [p()] }],
        },
        h(2, "Wenn etwas schiefgeht"),
        p(),
      ),
    },
    en: {
      title: "How-to",
      description: "Step by step, with prerequisites",
      content: doc(
        { type: "toc" },
        h(2, "Prerequisites"),
        bullets(""),
        h(2, "Steps"),
        {
          type: "orderedList",
          content: [{ type: "listItem", content: [p()] }],
        },
        h(2, "Troubleshooting"),
        p(),
      ),
    },
  },
  retro: {
    de: {
      title: "Rückblick",
      description: "Was lief gut, was nicht, was ändern wir",
      content: doc(
        h(2, "Was lief gut?"),
        bullets(""),
        h(2, "Was lief nicht gut?"),
        bullets(""),
        h(2, "Was ändern wir?"),
        tasks(""),
      ),
    },
    en: {
      title: "Retrospective",
      description: "What went well, what did not, what we change",
      content: doc(
        h(2, "What went well?"),
        bullets(""),
        h(2, "What did not go well?"),
        bullets(""),
        h(2, "What do we change?"),
        tasks(""),
      ),
    },
  },
};

export const builtInTemplates = (locale: string) => {
  const lang: Lang = locale.startsWith("de") ? "de" : "en";
  return Object.entries(BUILT_IN).map(([key, t]) => ({
    id: `builtin:${key}`,
    ...t[lang],
  }));
};
