// Code highlighting in the panel's file preview.
//
// We don't pull in a library here: the panel lives without a build step and external
// scripts, and the whole parsing is a single pass over the line. The highlighting does
// not trust the file: anything not recognized as a token is escaped, so HTML from the
// file won't get into the page. The file is a plain script: chat-ui.ts inserts it into
// the page before chat-client.js, and `highlightCode` is visible to the client as a
// global function.
/* exported highlightCode */

const CODE_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function codeEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => CODE_ESCAPES[char]);
}

const WORD_START = /[A-Za-z_$]/;
const WORD_PART = /[\w$]/;
const NUMBER_PART = /[\w.]/;
const DIGIT = /\d/;

const JS_KEYWORDS =
  'async await break case catch class const continue debugger default delete do else export ' +
  'extends finally for from function get if import in instanceof let new of return set static ' +
  'super switch this throw try typeof var void while yield';
const TS_KEYWORDS =
  JS_KEYWORDS +
  ' abstract any as asserts bigint boolean declare enum implements infer interface is keyof ' +
  'never number object override private protected public readonly satisfies string symbol type ' +
  'unknown';

/** Preview language: what counts as a comment, a string, and a keyword. */
function codeLanguage(config) {
  return {
    line: config.line ?? [],
    block: Boolean(config.block),
    template: Boolean(config.template),
    // Keys (CSS properties, YAML/TOML fields) are recognized by a colon, not by a list.
    keys: Boolean(config.keys),
    keywords: new Set(String(config.keywords ?? '').split(/\s+/).filter(Boolean)),
  };
}

const JS = codeLanguage({ line: ['//'], block: true, template: true, keywords: JS_KEYWORDS });
const TS = codeLanguage({ line: ['//'], block: true, template: true, keywords: TS_KEYWORDS });

const CODE_LANGUAGES = {
  JS,
  JSX: JS,
  TS,
  TSX: TS,
  JSON: codeLanguage({ keywords: 'true false null' }),
  PYTHON: codeLanguage({
    line: ['#'],
    keywords:
      'and as assert async await break class continue def del elif else except False finally ' +
      'for from global if import in is lambda None nonlocal not or pass raise return True try ' +
      'while with yield self',
  }),
  SHELL: codeLanguage({
    line: ['#'],
    keywords:
      'case do done elif else esac fi for function if in local readonly return set then until ' +
      'while export unset echo exit source',
  }),
  SQL: codeLanguage({
    line: ['--'],
    block: true,
    keywords:
      'add all alter and as asc begin between by case check column commit constraint create ' +
      'database default delete desc distinct drop else end exists foreign from full group having ' +
      'if in index inner insert into is join key left like limit not null on or order outer ' +
      'primary references right rollback select set table then union unique update values view ' +
      'when where with',
  }),
  YAML: codeLanguage({ line: ['#'], keys: true, keywords: 'true false null yes no on off' }),
  TOML: codeLanguage({ line: ['#'], keys: true, keywords: 'true false' }),
  INI: codeLanguage({ line: ['#', ';'], keys: true, keywords: 'true false' }),
  // CSS only has block comments: `#fff` is a color, not the start of a comment.
  CSS: codeLanguage({ block: true, keys: true }),
};

/** The string ends at the quote, not at the end of the file: `\` escapes the character. */
function codeStringEnd(source, start, quote, multiline) {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (char === '\n' && !multiline) return index;
    index += 1;
  }
  return index;
}

/** The first token on the line before `:` or `=` is a key: a CSS property, a
 *  YAML/TOML field. In CSS a property starts after `{` or `;`, in YAML — at the start
 *  of the line. */
function codeLooksLikeKey(source, start, end) {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const before = source.slice(lineStart, start);
  if (before.trim() && !/[{;]\s*$/.test(before)) return false;
  let index = end;
  while (index < source.length && (source[index] === ' ' || source[index] === '\t')) index += 1;
  return source[index] === ':' || source[index] === '=';
}

/**
 * HTML with highlighting, or `null` if the language is unknown: then the panel shows
 * the text as is — better without color than with guesswork.
 */
function highlightCode(text, type) {
  const language = CODE_LANGUAGES[String(type ?? '').toUpperCase()];
  if (!language) return null;

  const source = String(text ?? '');
  const out = [];
  let plain = '';
  let index = 0;

  const flush = () => {
    if (!plain) return;
    out.push(codeEscape(plain));
    plain = '';
  };
  const token = (kind, value) => {
    flush();
    out.push('<span class="tok-' + kind + '">' + codeEscape(value) + '</span>');
  };

  while (index < source.length) {
    const char = source[index];

    const lineMark = language.line.find((mark) => source.startsWith(mark, index));
    if (lineMark) {
      let end = source.indexOf('\n', index);
      if (end === -1) end = source.length;
      token('comment', source.slice(index, end));
      index = end;
      continue;
    }
    if (language.block && source.startsWith('/*', index)) {
      let end = source.indexOf('*/', index + 2);
      end = end === -1 ? source.length : end + 2;
      token('comment', source.slice(index, end));
      index = end;
      continue;
    }
    if (char === '"' || char === "'" || (language.template && char === '`')) {
      const end = codeStringEnd(source, index, char, char === '`');
      token('string', source.slice(index, end));
      index = end;
      continue;
    }
    // A number only at the start of a word: in `a1` it's part of the identifier, not a token.
    if (DIGIT.test(char) && (index === 0 || !WORD_PART.test(source[index - 1]))) {
      let end = index + 1;
      while (end < source.length && NUMBER_PART.test(source[end])) end += 1;
      token('number', source.slice(index, end));
      index = end;
      continue;
    }
    if (WORD_START.test(char)) {
      let end = index + 1;
      while (end < source.length && WORD_PART.test(source[end])) end += 1;
      const word = source.slice(index, end);
      if (language.keys && codeLooksLikeKey(source, index, end)) token('key', word);
      else if (language.keywords.has(word)) token('keyword', word);
      else plain += word;
      index = end;
      continue;
    }
    plain += char;
    index += 1;
  }
  flush();
  return out.join('');
}
