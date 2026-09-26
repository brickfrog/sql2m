// Small tokenizers for SQL and M, good enough for colouring an editor.
// They build DOM nodes with textContent, so user text is never parsed as HTML.

export type Lang = 'sql' | 'm';
type Kind = 'kw' | 'fn' | 'str' | 'num' | 'com' | null;
type Token = [Kind, string];

function words(list: string): Record<string, true> {
  // Null prototype: identifiers like `constructor` must not look like keywords.
  const out = Object.create(null) as Record<string, true>;
  for (const w of list.split(/\s+/)) if (w !== '') out[w] = true;
  return out;
}

const SQL_KEYWORDS = words(
  `all and anti any as asc asof between by case cast create cross cube cte current default delete desc distinct drop else end except exclude
  exists false filter first following for from full group grouping groups having ignore ilike in inner insert intersect interval into is
  join last lateral left like limit materialized not null nulls offset on or order outer over partition positional preceding qualify
  range recursive replace right rollup row rows select semi set sets table then ties true union unbounded update using values view when
  where window with`,
);

const SQL_TYPES = words(
  `bigint bit blob bool boolean bytea char date datetime decimal double float float4 float8 hugeint int int2 int4 int8 integer interval
  json numeric real smallint string text time timestamp timestamptz tinyint ubigint uhugeint uinteger usmallint utinyint uuid varchar`,
);

const M_KEYWORDS = words(
  'and as each else error false if in is let meta not null nullable optional or otherwise section shared then true try type',
);

const SQL_TOKEN =
  /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|([A-Za-z_][\w$]*)(?=(\s*\()?)|(\s+|[\s\S])/giy;

const M_TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(#?"(?:[^"]|"")*"?)|(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)|(\s+|[\s\S])/gy;

function sqlTokens(text: string): Token[] {
  const out: Token[] = [];
  SQL_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (SQL_TOKEN.lastIndex < text.length && (m = SQL_TOKEN.exec(text)) !== null) {
    if (m[1] !== undefined) out.push(['com', m[1]]);
    else if (m[2] !== undefined) out.push(['str', m[2]]);
    else if (m[3] !== undefined) out.push([null, m[3]]);
    else if (m[4] !== undefined) out.push(['num', m[4]]);
    else if (m[5] !== undefined) {
      const w = m[5].toLowerCase();
      out.push([SQL_KEYWORDS[w] ? 'kw' : SQL_TYPES[w] || m[6] !== undefined ? 'fn' : null, m[5]]);
    } else out.push([null, m[0]]);
  }
  return out;
}

function mTokens(text: string): Token[] {
  const out: Token[] = [];
  M_TOKEN.lastIndex = 0;
  let afterType = false;
  let m: RegExpExecArray | null;
  while (M_TOKEN.lastIndex < text.length && (m = M_TOKEN.exec(text)) !== null) {
    if (m[1] !== undefined) out.push(['com', m[1]]);
    else if (m[2] !== undefined) out.push([m[2].startsWith('#') ? null : 'str', m[2]]);
    else if (m[3] !== undefined) out.push(['num', m[3]]);
    else if (m[4] !== undefined) {
      const w = m[4];
      // `type number`, `type nullable text`: the type name reads as part of the keyword.
      const kind: Kind = M_KEYWORDS[w] || afterType ? 'kw' : w.includes('.') ? 'fn' : null;
      out.push([kind, w]);
      afterType = w === 'type' || (afterType && w === 'nullable');
      continue;
    } else out.push([null, m[0]]);
    if (m[0].trim() !== '') afterType = false;
  }
  return out;
}

/** Replaces `el`'s children with coloured spans for `text`. */
export function highlight(el: HTMLElement, text: string, lang: Lang): void {
  const frag = document.createDocumentFragment();
  for (const [kind, s] of lang === 'sql' ? sqlTokens(text) : mTokens(text)) {
    if (kind === null) {
      const last = frag.lastChild;
      if (last !== null && last.nodeType === Node.TEXT_NODE) (last as Text).appendData(s);
      else frag.append(s);
      continue;
    }
    const span = document.createElement('span');
    span.className = `t-${kind}`;
    span.textContent = s;
    frag.append(span);
  }
  el.replaceChildren(frag);
}

/** "1\n2\n…" for a gutter next to `text`. */
export function lineNumbers(text: string): string {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return Array.from({ length: n }, (_, i) => String(i + 1)).join('\n');
}
