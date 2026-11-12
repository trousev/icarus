// Адреса элементов артефакта: `data-icarus-ref` прямо в исходнике.
//
// Панель показывает HTML в песочнице, а человек хочет ткнуть в блок и сказать
// «сделай компактнее». Ссылке из чата нельзя гнить: поэтому адрес живёт в самом
// файле, рядом с элементом, а не только в состоянии панели. Адрес собирается из
// id и классов — они переживают повторную генерацию лучше, чем порядковый номер.
//
// Модуль не знает ни про HTTP, ни про git: это чистая работа с исходником,
// чтобы правила адресов можно было проверить тестами и не держать их в голове.
import crypto from 'node:crypto';
import { ArtifactError } from './artifacts.ts';

export const REF_ATTR = 'data-icarus-ref';

/** Элемент, у которого есть адрес: то, что панель может предложить человеку. */
export type ArtifactRef = {
  ref: string;
  tag: string;
  /** Короткая цитата: по ней человек узнаёт блок, а модель — что это за место. */
  quote: string;
  /** Текст можно править прямо в предпросмотре: элемент без вложенных тегов. */
  editable: boolean;
};

export type AnnotateResult = {
  html: string;
  refs: ArtifactRef[];
  changed: boolean;
};

// Теги, внутри которых лежит не разметка, а данные: адресовать их бессмысленно.
const RAW = new Set(['script', 'style', 'textarea', 'title']);
// Служебная обвязка: её не видно в предпросмотре, ссылки на неё не нужны.
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
  /** Позиция сразу после имени тега: туда встаёт новый атрибут. */
  nameEnd: number;
  /** Позиция после `>` открывающего тега. */
  openEnd: number;
  /** Позиция `</tag>`; -1 — закрывающего тега не было. */
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
 * Разбор HTML: только то, что нужно адресам, — вложенность, атрибуты и позиции.
 * Никаких зависимостей от парсера: исходник мы обязаны вернуть байт в байт,
 * кроме вставленных атрибутов, и чужой парсер тут только мешает.
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
      // Ищем парный тег в стеке: на битой вложенности не падаем, а закрываем
      // ближайший такой же — исходник всё равно важнее строгости.
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

/** Адресуем то, что видно и на что можно ткнуть: тело страницы без скриптов. */
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
 * Сегмент пути: тег плюс id или первый класс. Дубли среди соседей получают
 * номер — это единственная часть адреса, которая зависит от порядка, поэтому
 * она появляется только когда без неё адрес неоднозначен.
 */
function segment(node: Element, siblings: Element[]): string {
  const base = signature(node);
  const same = siblings.filter((sibling) => signature(sibling) === base);
  if (same.length <= 1) return base;
  return `${base}[${same.indexOf(node) + 1}]`;
}

function pathOf(node: Element, rootSiblings: Element[]): string {
  // Ближайший предок с id делает адрес короче и переживает вставки рядом:
  // id — самый сильный контракт, который есть в разметке.
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
        // Пробел между соседними блоками: без него цитата склеивает заголовок
        // и абзац в одно слово, и человек не узнаёт элемент.
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

/** Адреса, которые уже лежат в исходнике. Порядок — как в документе. */
export function refsOf(html: string): ArtifactRef[] {
  const { all, body } = parse(html);
  return refsOfNodes(all.filter((node) => annotatable(node, body)));
}

/** Короткий отпечаток исходника: им панель проверяет, что элемент не устарел. */
export function hashOf(html: string): string {
  return crypto.createHash('sha256').update(html, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Проставить `data-icarus-ref` всем элементам тела. Идемпотентно: уже
 * размеченные элементы не трогаем, повторный вызов ничего не меняет.
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
    // Совпадение возможно, если адрес пришёл из соседнего поддерева с тем же
    // id: не затираем чужой контракт, а разводим новый адрес номером.
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
 * Заменить текст элемента по адресу. Меняем только внутренний текст листового
 * элемента: у контейнера замена снесла бы вложенную разметку, а это уже не
 * «поправить подпись», а «сломать вёрстку» — такие правки уходят в чат.
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
  // Отступы вокруг текста сохраняем: исходник должен остаться читаемым.
  const replacement = inner.trim() === '' ? escapeText(value) : `${lead}${escapeText(value)}${trail}`;
  const before = textOf(node);
  return {
    html: html.slice(0, node.openEnd) + replacement + html.slice(node.closeStart),
    before,
  };
}
