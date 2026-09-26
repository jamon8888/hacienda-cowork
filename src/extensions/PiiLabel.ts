import { Decoration, Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import { detectRegex } from '../lib/pii/regex-detector';
import { buildPiiLabelAttributes, findRedactedTokens } from '../lib/pii/labels';

export type PiiLabelMode = 'view' | 'compose';

export interface PiiLabelOptions {
  mode: PiiLabelMode;
}

export interface PiiLabelStorage {
  mode: PiiLabelMode;
  showOriginals: boolean;
  rehydrationMap: Record<string, string>;
  /** Injected by the viewer from basemind.pii.tokenAriaLabel. */
  tokenAriaLabel?: (categoryLabel: string) => string;
}

export interface PiiSpan {
  category: string;
  token: string;
  from: number;
  to: number;
}

/**
 * Find PII spans within a single text node's text, with offsets relative to
 * the start of that text. View mode scans stored `[TYPE_N]` tokens; compose
 * mode runs the structured regex detector for instant feedback and still
 * surfaces existing tokens so a redacted note stays labelled while editing.
 */
export function piiSpansForText(text: string, mode: PiiLabelMode): PiiSpan[] {
  const tokenSpans = findRedactedTokens(text).map((token) => ({
    category: token.category,
    token: token.token,
    from: token.start,
    to: token.end,
  }));
  if (mode === 'view') return tokenSpans;
  const regexSpans = detectRegex(text).map((detection) => ({
    category: detection.category,
    token: detection.text,
    from: detection.start,
    to: detection.end,
  }));
  const merged = [...tokenSpans];
  for (const span of regexSpans) {
    const overlaps = merged.some((existing) => span.from < existing.to && existing.from < span.to);
    if (!overlaps) merged.push(span);
  }
  return merged.sort((a, b) => a.from - b.from);
}

function decorationsForSpan(
  span: PiiSpan,
  range: { from: number; to: number },
  storage: PiiLabelStorage,
): InstanceType<typeof Decoration>[] {
  const original = storage.rehydrationMap[span.token];
  if (storage.showOriginals && original) {
    // View-only: hide the token and draw the original beside it so the doc
    // (and save) keep tokens — ProseMirror has no replace-decoration.
    return [
      Decoration.Inline(range.from, range.to, { style: 'display: none' }),
      Decoration.Widget(
        range.from,
        () => {
          const el = document.createElement('span');
          el.className = 'oa-pii-original';
          el.dataset.category = span.category;
          el.textContent = original;
          return el;
        },
        { key: `pii-orig-${range.from}-${span.token}`, side: -1 },
      ),
    ];
  }
  return [
    Decoration.Inline(
      range.from,
      range.to,
      buildPiiLabelAttributes({ category: span.category, token: span.token }, range, storage.tokenAriaLabel),
    ),
  ];
}

function scanRange(
  state: { doc: { nodesBetween: ProseMirrorNode['nodesBetween'] } },
  from: number,
  to: number,
  storage: PiiLabelStorage,
): InstanceType<typeof Decoration>[] {
  const decorations: InstanceType<typeof Decoration>[] = [];
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isText || !node.text) return true;
    if (parent?.type.name === 'codeBlock') return true;
    if (node.marks.some((mark) => mark.type.name === 'link' || mark.type.name === 'code')) {
      return true;
    }
    for (const span of piiSpansForText(node.text, storage.mode)) {
      const range = { from: pos + span.from, to: pos + span.to };
      decorations.push(...decorationsForSpan(span, range, storage));
    }
    return true;
  });
  return decorations;
}

export const PiiLabel = Extension.create<PiiLabelOptions>({
  name: 'piiLabel',

  addOptions() {
    return { mode: 'compose' };
  },

  addStorage(): PiiLabelStorage {
    return {
      mode: 'compose',
      showOriginals: true,
      rehydrationMap: {},
    };
  },

  addDecorations() {
    return {
      create: ({ state }) => {
        const storage = this.storage as PiiLabelStorage;
        return scanRange(state, 0, state.doc.content.size, storage);
      },
      // Storage edits (Show Originals / mode) do not change the doc; force a
      // rebuild via editor.commands.updateDecorations('piiLabel').
    };
  },
});
