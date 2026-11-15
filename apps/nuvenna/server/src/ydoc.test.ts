import { sanitizeDoc } from "@tvn/core";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { docToYdoc, ydocToDoc } from "./ydoc.js";

const doc = sanitizeDoc({
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Drucker" }],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Toner " },
        { type: "text", text: "wechseln", marks: [{ type: "bold" }] },
        { type: "text", text: " siehe ", marks: [] },
        {
          type: "text",
          text: "Anleitung",
          marks: [{ type: "link", attrs: { href: "https://example.org" } }],
        },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Fach 2" }] },
          ],
        },
      ],
    },
  ],
});

it("round-trips Tiptap JSON through Yjs", () => {
  expect(ydocToDoc(docToYdoc(doc))).toEqual(doc);
});

it("keeps both sides of concurrent edits", () => {
  const a = docToYdoc(doc);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  // Each side adds a paragraph without seeing the other.
  const add = (y: Y.Doc, text: string) => {
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, text);
    p.insert(0, [t]);
    y.getXmlFragment("default").push([p]);
  };
  add(a, "von Anna");
  add(b, "von Bert");
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const texts = (y: Y.Doc) => JSON.stringify(ydocToDoc(y));
  expect(texts(a)).toBe(texts(b));
  expect(texts(a)).toContain("von Anna");
  expect(texts(a)).toContain("von Bert");
});
