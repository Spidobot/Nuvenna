// Tiptap JSON ⇄ Yjs, in the layout y-prosemirror uses on the client (the
// Collaboration extension): one Y.XmlElement per node, attributes as element
// attributes, text in Y.XmlText with marks as formatting. No ProseMirror
// schema is needed here; whatever comes out goes through sanitizeDoc.
import { sanitizeDoc, type RichDoc, type RichNode } from "@tvn/core";
import * as Y from "yjs";

/** Name of the shared fragment; the Collaboration extension's default. */
export const FRAGMENT = "default";

function fill(parent: Y.XmlFragment | Y.XmlElement, nodes: RichNode[]) {
  const children: (Y.XmlElement | Y.XmlText)[] = [];
  let text: Y.XmlText | null = null;
  // A Y.XmlText not yet in a document reports length 0: count ourselves.
  let at = 0;
  for (const n of nodes) {
    if (n.type === "text") {
      // Neighbouring text nodes share one Y.XmlText, as y-prosemirror does.
      if (!text) {
        children.push((text = new Y.XmlText()));
        at = 0;
      }
      const marks = Object.fromEntries(
        (n.marks ?? []).map((m) => [m.type, m.attrs ?? {}]),
      );
      text.insert(at, n.text ?? "", marks);
      at += (n.text ?? "").length;
      continue;
    }
    text = null;
    const el = new Y.XmlElement(n.type);
    for (const [k, v] of Object.entries(n.attrs ?? {}))
      if (v !== null && v !== undefined) el.setAttribute(k, v as string);
    fill(el, n.content ?? []);
    children.push(el);
  }
  parent.insert(0, children);
}

/** A new Yjs document holding this content. */
export function docToYdoc(doc: RichDoc): Y.Doc {
  const ydoc = new Y.Doc();
  fill(ydoc.getXmlFragment(FRAGMENT), doc.content ?? []);
  return ydoc;
}

function read(item: Y.XmlElement | Y.XmlText): RichNode[] {
  if (item instanceof Y.XmlText)
    return (
      item.toDelta() as {
        insert: unknown;
        attributes?: Record<string, Record<string, unknown>>;
      }[]
    )
      .filter((d) => typeof d.insert === "string" && d.insert)
      .map((d) => {
        const marks = Object.entries(d.attributes ?? {}).map(([type, attrs]) =>
          attrs && typeof attrs === "object" && Object.keys(attrs).length
            ? { type, attrs }
            : { type },
        );
        return {
          type: "text",
          text: d.insert as string,
          ...(marks.length && { marks }),
        };
      });
  const attrs = item.getAttributes();
  const content = item
    .toArray()
    .flatMap((c) => read(c as Y.XmlElement | Y.XmlText));
  return [
    {
      type: item.nodeName,
      ...(Object.keys(attrs).length && { attrs }),
      ...(content.length && { content }),
    },
  ];
}

/** The content of a Yjs document as checked Tiptap JSON. */
export function ydocToDoc(ydoc: Y.Doc): RichDoc {
  const content = ydoc
    .getXmlFragment(FRAGMENT)
    .toArray()
    .flatMap((c) => read(c as Y.XmlElement | Y.XmlText));
  return sanitizeDoc({ type: "doc", content });
}
