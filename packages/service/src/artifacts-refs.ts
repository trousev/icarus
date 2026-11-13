// Addresses of artifact elements: `data-icarus-ref` right in the source.
//
// The panel shows HTML in a sandbox, and a person wants to poke a block and say
// "make it more compact". A link from the chat must not rot: therefore the address lives in the
// file itself, next to the element, and not only in the panel state. The address is assembled from
// id and classes — they survive regeneration better than an ordinal number.
//
// The module knows neither HTTP nor git: this is pure work with the source,
// so that address rules can be checked by tests and not kept in one's head.
import crypto from 'node:crypto';
import { ArtifactError } from './artifacts.ts';

export const REF_ATTR = 'data-icarus-ref';

/** An element that has an address: something the panel can offer to a person. */
export type ArtifactRef = {
  ref: string;
  tag: string;
  /** A short quote: by it a person recognizes the block, and the model — what place this is. */
  quote: string;
  /** Text can be edited right in the preview: an element without nested tags. */
  editable: boolean;
};

export type AnnotateResult = {
  html: string;
  refs: ArtifactRef[];
  changed: boolean;
};

// Tags inside which there is not markup but data: addressing them is pointless.
const RAW = new Set(['script', 'style', 'textarea', 'title']);
// Service scaffolding: it is not visible in the preview, links to it are not needed.
const SKIP = new Set(['script', 'style', 'template', 'head', 'meta', 'link', 'title', 'noscript']);
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'param', 'source', 'track', 'wbr',
]);
const QUOTE_LIMIT = 120;
const REF_LIMIT = 240;
const TEXT_LIMIT = 4000;

type Element = {
  tag: string;
  attrs: Map<string, string>;
  /** Position right after the tag name: a new attribute goes there. */
  nameEnd: number;
  /** Position after the `>` of the opening tag. */
  openEnd: number;
  /** Position of `</tag>`; -1 — there was no closing tag. */
  closeStart: number;
  parent: Element | null;
  parts: Array<string | Element>;
  order: number;
};

type Parsed = { roots: Element[]; body: Element | null; all: Element[] };

function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const name = (match[1] ?? '').toLowerCase();
    if (!name) continue;
    attrs.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/**
 * HTML parsing: only what addresses need — nesting, attributes and positions.
 * No dependency on a parser: we must return the source byte for byte,
 * except for inserted attributes, and someone else's parser only gets in the way here.
 */
function parse(html: string): Parsed {
  const roots: Element[] = [];
  const all: Element[] = [];
  const stack: Element[] = [];
  let body: Element | null = null;
  let order = 0;

  const addText = (text: string): void => {
    const parent = stack[stack.length - 1];
    if (parent && text) parent.parts.push(text);
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      addText(html.slice(i));
      break;
    }
    if (lt > i) addText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt + 2);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    const closing = html[lt + 1] === '/';
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:_-]*/.exec(html.slice(lt + (closing ? 2 : 1)));
    if (!nameMatch) {
      addText('<');
      i = lt + 1;
      continue;
    }
    const rawName = nameMatch[0];
    const tag = rawName.toLowerCase();
    const nameEnd = lt + (closing ? 2 : 1) + rawName.length;

    let j = nameEnd;
    let quote = '';
    while (j < html.length) {
      const char = html[j] ?? '';
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
      j += 1;
    }
    const openEnd = Math.min(html.length, j + 1);

    if (closing) {
      // Look for the matching tag in the stack: on broken nesting we do not fall,
      // but close the nearest same one — the source is more important than strictness anyway.
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        const candidate = stack[k];
        if (candidate && candidate.tag === tag) {
          candidate.closeStart = lt;
          stack.length = k;
          break;
        }
      }
      i = openEnd;
      continue;
    }

    const inside = html.slice(nameEnd, j);
    const selfClosing = /\/\s*$/.test(inside) || VOID.has(tag);
    const element: Element = {
      tag,
      attrs: parseAttrs(inside),
      nameEnd,
      openEnd,
      closeStart: -1,
      parent: stack[stack.length - 1] ?? null,
      parts: [],
      order: order++,
    };
    if (element.parent) element.parent.parts.push(element);
    else roots.push(element);
    all.push(element);
    if (tag === 'body') body = element;

    if (selfClosing) {
      i = openEnd;
      continue;
    }
    if (RAW.has(tag)) {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'ig');
      closeRe.lastIndex = openEnd;
      const match = closeRe.exec(html);
      if (match) {
        element.closeStart = match.index;
        i = match.index + match[0].length;
      } else {
        i = html.length;
      }
      continue;
    }
    stack.push(element);
    i = openEnd;
  }

  return { roots, body, all };
}

function elementsOf(node: Element): Element[] {
  const out: Element[] = [];
  for (const part of node.parts) if (typeof part !== 'string') out.push(part);
  return out;
}

function cleanId(value: string | undefined): string {
  const id = (value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_:-]{0,79}$/.test(id) ? id : '';
}

function firstClass(value: string | undefined): string {
  for (const token of (value ?? '').split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_-]{0,39}$/.test(token)) return token;
  }
  return '';
}

function insideSvg(node: Element): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.tag === 'svg') return true;
  }
  return false;
}

/** We address what is visible and can be poked: the page body without scripts. */
function annotatable(node: Element, body: Element | null): boolean {
  if (SKIP.has(node.tag) || node.tag === 'body' || node.tag === 'html') return false;
  if (node.tag === 'svg' && insideSvg(node)) return false;
  if (insideSvg(node)) return false;
  if (body) {
    for (let current: Element | null = node.parent; current; current = current.parent) {
      if (current === body) return true;
    }
    return false;
  }
  return true;
}

function signature(node: Element): string {
  const id = cleanId(node.attrs.get('id'));
  if (id) return `${node.tag}#${id}`;
  const cls = firstClass(node.attrs.get('class'));
  return cls ? `${node.tag}.${cls}` : node.tag;
}

/**
 * Path segment: tag plus id or first class. Duplicates among siblings get a
 * number — this is the only part of the address that depends on order, therefore
 * it appears only when without it the address is ambiguous.
 */
function segment(node: Element, siblings: Element[]): string {
  const base = signature(node);
  const same = siblings.filter((sibling) => signature(sibling) === base);
  if (same.length <= 1) return base;
  return `${base}[${same.indexOf(node) + 1}]`;
}

function pathOf(node: Element, rootSiblings: Element[]): string {
  // The nearest ancestor with an id makes the address shorter and survives insertions nearby:
  // id is the strongest contract there is in markup.
  let start = node;
  for (let current: Element | null = node.parent; current; current = current.parent) {
    if (cleanId(current.attrs.get('id'))) {
      start = current;
      break;
    }
  }

  const parts: string[] = [];
  for (let current: Element | null = start; current; current = current.parent) {
    if (current.tag === 'html') break;
    if (current.tag === 'body') continue;
    const parent = current.parent;
    const siblings = parent ? elementsOf(parent) : rootSiblings;
    parts.unshift(segment(current, siblings));
  }
  return parts.join('/');
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function textOf(node: Element, limit = QUOTE_LIMIT): string {
  let out = '';
  const walk = (current: Element): void => {
    if (out.length >= limit) return;
    for (const part of current.parts) {
      if (out.length >= limit) return;
      if (typeof part === 'string') {
        out += part;
      } else if (!SKIP.has(part.tag)) {
        // A space between neighboring blocks: without it the quote glues the heading
        // and the paragraph into one word, and the person does not recognize the element.
        out += ' ';
        walk(part);
        out += ' ';
      }
    }
  };
  walk(node);
  const text = normalize(out);
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function refsOfNodes(nodes: Element[]): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  for (const node of nodes) {
    const ref = (node.attrs.get(REF_ATTR) ?? '').trim();
    if (!ref) continue;
    refs.push({
      ref,
      tag: node.tag,
      quote: textOf(node),
      editable: !VOID.has(node.tag) && !RAW.has(node.tag) && elementsOf(node).length === 0 && textOf(node) !== '',
    });
  }
  return refs;
}

/** Addresses that already lie in the source. Order — as in the document. */
export function refsOf(html: string): ArtifactRef[] {
  const { all, body } = parse(html);
  return refsOfNodes(all.filter((node) => annotatable(node, body)));
}

/** A short fingerprint of the source: the panel uses it to check that the element is not stale. */
export function hashOf(html: string): string {
  return crypto.createHash('sha256').update(html, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Put `data-icarus-ref` on all body elements. Idempotent: already
 * marked elements are not touched, a repeated call changes nothing.
 */
export function annotate(html: string): AnnotateResult {
  const { all, body, roots } = parse(html);
  const scope = all.filter((node) => annotatable(node, body));
  const rootSiblings = body ? elementsOf(body) : roots;

  const used = new Set<string>();
  for (const node of scope) {
    const existing = (node.attrs.get(REF_ATTR) ?? '').trim();
    if (existing) used.add(existing);
  }

  const edits: Array<{ at: number; text: string }> = [];
  const assigned = new Map<Element, string>();
  for (const node of scope) {
    const existing = (node.attrs.get(REF_ATTR) ?? '').trim();
    if (existing) {
      assigned.set(node, existing);
      continue;
    }
    let ref = pathOf(node, rootSiblings).slice(0, REF_LIMIT);
    if (!ref) continue;
    // A collision is possible if the address came from a neighboring subtree with the same
    // id: we do not overwrite someone else's contract, but separate the new address with a number.
    if (used.has(ref)) {
      let index = 2;
      while (used.has(`${ref}:${index}`)) index += 1;
      ref = `${ref}:${index}`;
    }
    used.add(ref);
    assigned.set(node, ref);
    edits.push({ at: node.nameEnd, text: ` ${REF_ATTR}="${ref}"` });
  }

  let next = html;
  for (const edit of edits.sort((left, right) => right.at - left.at)) {
    next = next.slice(0, edit.at) + edit.text + next.slice(edit.at);
  }

  const refs = scope
    .map((node) => {
      const ref = assigned.get(node) ?? '';
      if (!ref) return null;
      return {
        ref,
        tag: node.tag,
        quote: textOf(node),
        editable:
          !VOID.has(node.tag) &&
          !RAW.has(node.tag) &&
          elementsOf(node).length === 0 &&
          textOf(node) !== '',
      };
    })
    .filter((item): item is ArtifactRef => item !== null);

  return { html: next, refs, changed: edits.length > 0 };
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Replace the text of an element by address. We change only the inner text of a leaf
 * element: for a container, replacement would wipe out nested markup, and that is no longer
 * "fix the caption" but "break the layout" — such edits go to the chat.
 */
export function replaceText(
  html: string,
  ref: string,
  text: string,
): { html: string; before: string } {
  const wanted = (ref ?? '').trim();
  if (!wanted) throw new ArtifactError('не указан элемент — выбери его в предпросмотре', 400);
  const { all, body } = parse(html);
  const matches = all.filter(
    (node) => annotatable(node, body) && (node.attrs.get(REF_ATTR) ?? '').trim() === wanted,
  );
  if (matches.length === 0) {
    throw new ArtifactError(
      'элемент с такой ссылкой не найден — разметка устарела, выбери элемент заново',
      409,
    );
  }
  if (matches.length > 1) {
    throw new ArtifactError('ссылка неоднозначна: в исходнике несколько таких элементов', 409);
  }
  const node = matches[0]!;
  if (VOID.has(node.tag) || RAW.has(node.tag) || elementsOf(node).length > 0 || node.closeStart < 0) {
    throw new ArtifactError('этот элемент не текстовый — попроси правку в чате', 400);
  }

  const value = Array.from(text.replace(/\r\n?/g, '\n'))
    .filter((char) => char === '\n' || char === '\t' || char.charCodeAt(0) >= 32)
    .join('')
    .trim()
    .slice(0, TEXT_LIMIT);
  if (!value) throw new ArtifactError('текст не может быть пустым — элемент исчезнет', 400);

  const inner = html.slice(node.openEnd, node.closeStart);
  const lead = /^[ \t\r\n]*/.exec(inner)?.[0] ?? '';
  const trail = /[ \t\r\n]*$/.exec(inner)?.[0] ?? '';
  // We preserve the indentation around the text: the source must remain readable.
  const replacement = inner.trim() === '' ? escapeText(value) : `${lead}${escapeText(value)}${trail}`;
  const before = textOf(node);
  return {
    html: html.slice(0, node.openEnd) + replacement + html.slice(node.closeStart),
    before,
  };
}
