// A small Power Query M interpreter used as a test oracle.
//
// The test harness runs a SQL query in DuckDB and the transpiled M through
// evaluateM() on the same data, then compares rows. Only the subset of M that
// sql2m emits is supported; everything else fails loudly with an MError.
//
// Decisions the M documentation leaves open (or that differ from the real
// engine in ways that do not matter for sql2m) are marked "Decision:".
//
// Values:
//   null | number | string (text) | boolean (logical) | MDate | MDateTime
//   | Array (list) | MRecord | MTable | MFunction | MType
//
// Evaluation is eager except for `let` bindings (lazy, order independent),
// `and` / `or` / `??` (short-circuit) and `if` branches.
// Decision: record literal fields are evaluated eagerly in the enclosing
// scope; they cannot reference sibling fields.

// ---------------------------------------------------------------------------
// Value classes

export class MError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MError';
  }
}

const pad = (n, width) => String(n).padStart(width, '0');

function daysInMonth(y, m) {
  return [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function checkDate(y, m, d, what) {
  const ok = [y, m, d].every(Number.isInteger)
    && y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
  if (!ok) throw new MError(`${what}: invalid date ${y}-${m}-${d}`);
}

export class MDate {
  constructor(y, m, d) {
    checkDate(y, m, d, '#date');
    this.year = y;
    this.month = m;
    this.day = d;
  }

  /** Numeric key that orders dates chronologically. */
  key() {
    return this.year * 10000 + this.month * 100 + this.day;
  }

  toString() {
    return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`;
  }
}

export class MDateTime {
  constructor(y, mo, d, h, mi, s) {
    checkDate(y, mo, d, '#datetime');
    const ok = Number.isInteger(h) && Number.isInteger(mi) && typeof s === 'number'
      && h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s < 60;
    if (!ok) throw new MError(`#datetime: invalid time ${h}:${mi}:${s}`);
    this.year = y;
    this.month = mo;
    this.day = d;
    this.hour = h;
    this.minute = mi;
    this.second = s;
  }

  key() {
    const date = this.year * 10000 + this.month * 100 + this.day;
    return date * 86400 + this.hour * 3600 + this.minute * 60 + this.second;
  }

  toString() {
    const sec = this.second < 10 ? `0${this.second}` : String(this.second);
    return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)} ${pad(this.hour, 2)}:${pad(this.minute, 2)}:${sec}`;
  }
}

class MRecord {
  constructor(names, values) {
    this.fields = new Map();
    names.forEach((name, i) => {
      if (this.fields.has(name)) throw new MError(`record: duplicate field '${name}'`);
      this.fields.set(name, values[i]);
    });
  }
}

class MTable {
  constructor(columns, rows) {
    const seen = new Set();
    for (const c of columns) {
      if (seen.has(c)) throw new MError(`table: duplicate column '${c}'`);
      seen.add(c);
    }
    this.columns = columns;
    this.rows = rows;
  }
}

class MFunction {
  /** impl receives an argument array padded with null up to maxArgs. */
  constructor(name, minArgs, maxArgs, impl) {
    this.name = name;
    this.minArgs = minArgs;
    this.maxArgs = maxArgs;
    this.impl = impl;
  }
}

class MType {
  constructor(name, nullable) {
    this.name = name;
    this.nullable = nullable;
  }
}

/** Whole-day duration: the only duration the transpiler produces (date - date). */
class MDuration {
  constructor(days) {
    this.days = days;
  }
}

/** Days since 0001-01-01 (proleptic Gregorian). */
function dayNumber(d) {
  return Math.round((Date.UTC(d.year, d.month - 1, d.day) - Date.UTC(2000, 0, 1)) / 86400000);
}

function dateFromDayNumber(n) {
  const t = new Date(Date.UTC(2000, 0, 1) + n * 86400000);
  return new MDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function typeName(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'number': return 'number';
    case 'string': return 'text';
    case 'boolean': return 'logical';
  }
  if (v instanceof MDate) return 'date';
  if (v instanceof MDateTime) return 'datetime';
  if (Array.isArray(v)) return 'list';
  if (v instanceof MRecord) return 'record';
  if (v instanceof MTable) return 'table';
  if (v instanceof MFunction) return 'function';
  if (v instanceof MType) return 'type';
  if (v instanceof MDuration) return 'duration';
  throw new MError(`not an M value: ${String(v)}`);
}

// ---------------------------------------------------------------------------
// Equality and ordering

/** M `=`: null = null is true, different types are unequal, structural for containers. */
function mEquals(a, b) {
  if (a === null || b === null) return a === b;
  const ta = typeName(a);
  if (ta !== typeName(b)) return false;
  switch (ta) {
    case 'number':
    case 'text':
    case 'logical':
      return a === b;
    case 'date':
    case 'datetime':
      return a.key() === b.key();
    case 'list':
      return a.length === b.length && a.every((x, i) => mEquals(x, b[i]));
    case 'record':
      if (a.fields.size !== b.fields.size) return false;
      for (const [name, value] of a.fields) {
        if (!b.fields.has(name) || !mEquals(value, b.fields.get(name))) return false;
      }
      return true;
    case 'table': {
      // Column order does not matter; cells are matched by column name.
      if (a.columns.length !== b.columns.length || a.rows.length !== b.rows.length) return false;
      const map = a.columns.map((c) => b.columns.indexOf(c));
      if (map.includes(-1)) return false;
      return a.rows.every((row, r) => row.every((x, i) => mEquals(x, b.rows[r][map[i]])));
    }
    default:
      return a === b;
  }
}

const ORDERED = new Set(['number', 'text', 'logical', 'date', 'datetime']);

function orderKey(v) {
  return v instanceof MDate || v instanceof MDateTime ? v.key() : v;
}

/** M `<` `>` `<=` `>=`: null operand gives null; operands must share an ordered type. */
function relational(op, a, b) {
  if (a === null || b === null) return null;
  const ta = typeName(a);
  const tb = typeName(b);
  if (ta !== tb || !ORDERED.has(ta)) {
    throw new MError(`operator ${op}: cannot compare ${ta} with ${tb}`);
  }
  const x = orderKey(a);
  const y = orderKey(b);
  switch (op) {
    case '<': return x < y;
    case '>': return x > y;
    case '<=': return x <= y;
    default: return x >= y;
  }
}

/**
 * Total order used by Table.Sort and List.Min/Max: null lowest, then values of one
 * ordered type. Decision: mixed non-null types raise MError (a test oracle should
 * surface them rather than invent an order); NaN sorts above every other number.
 */
function sortCompare(a, b, fname) {
  if (a === null || b === null) return a === null ? (b === null ? 0 : -1) : 1;
  const ta = typeName(a);
  const tb = typeName(b);
  if (ta !== tb || !ORDERED.has(ta)) {
    throw new MError(`${fname}: cannot order ${ta} against ${tb}`);
  }
  const x = orderKey(a);
  const y = orderKey(b);
  if (ta === 'number') {
    const xn = Number.isNaN(x);
    const yn = Number.isNaN(y);
    if (xn || yn) return xn === yn ? 0 : xn ? 1 : -1;
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Hash key for a tuple of primitive values such that equal keys <=> tuples equal
 * under M `=`. Returns null when a value is not hashable (containers, NaN); such
 * tuples are compared linearly with mEquals. A hashable tuple can never equal an
 * unhashable one.
 */
function hashKey(values) {
  const parts = [];
  for (const v of values) {
    if (v === null) parts.push('z');
    else if (typeof v === 'number') {
      if (Number.isNaN(v)) return null;
      parts.push(`n${v}`);
    } else if (typeof v === 'string') parts.push(`s${v}`);
    else if (typeof v === 'boolean') parts.push(`b${v}`);
    else if (v instanceof MDate) parts.push(`d${v}`);
    else if (v instanceof MDateTime) parts.push(`t${v}`);
    else return null;
  }
  return JSON.stringify(parts);
}

const tupleEquals = (a, b) => a.every((x, i) => mEquals(x, b[i]));

/** Groups items by key tuple (M `=` equality) in order of first appearance. */
function groupBy(items, keyOf) {
  const groups = [];
  const byHash = new Map();
  const unhashable = [];
  for (const item of items) {
    const key = keyOf(item);
    const h = hashKey(key);
    let group = h === null ? unhashable.find((g) => tupleEquals(g.key, key)) : byHash.get(h);
    if (!group) {
      group = { key, items: [] };
      groups.push(group);
      if (h === null) unhashable.push(group);
      else byHash.set(h, group);
    }
    group.items.push(item);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Operators

function arithmetic(op, a, b) {
  if (a === null || b === null) return null;
  if (op === '-' && a instanceof MDate && b instanceof MDate) return new MDuration(dayNumber(a) - dayNumber(b));
  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new MError(`operator ${op}: cannot apply to ${typeName(a)} and ${typeName(b)}`);
  }
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    default: return a / b;
  }
}

function concat(a, b) {
  if (a === null || b === null) return null;
  if (typeof a === 'string' && typeof b === 'string') return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (a instanceof MRecord && b instanceof MRecord) {
    const merged = new Map([...a.fields, ...b.fields]);
    return new MRecord([...merged.keys()], [...merged.values()]);
  }
  throw new MError(`operator &: cannot apply to ${typeName(a)} and ${typeName(b)}`);
}

function checkLogical(op, v) {
  if (v !== null && typeof v !== 'boolean') {
    throw new MError(`operator ${op}: expected logical, got ${typeName(v)}`);
  }
  return v;
}

function fieldAccess(target, name, optional) {
  if (target instanceof MRecord) {
    if (target.fields.has(name)) return target.fields.get(name);
    if (optional) return null;
    throw new MError(`field '${name}' not found in record (fields: ${[...target.fields.keys()].join(', ')})`);
  }
  if (target instanceof MTable) {
    const i = target.columns.indexOf(name);
    if (i >= 0) return target.rows.map((r) => r[i]);
    if (optional) return null;
    throw new MError(`column '${name}' not found in table (columns: ${target.columns.join(', ')})`);
  }
  // Decision: optional access on null yields null; required access errors.
  if (target === null && optional) return null;
  throw new MError(`cannot access field '${name}' of a ${typeName(target)} value`);
}

function itemAccess(target, index, optional) {
  if (target === null && optional) return null;
  if (!Array.isArray(target) && !(target instanceof MTable)) {
    throw new MError(`cannot access item {${index}} of a ${typeName(target)} value`);
  }
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new MError(`item access: index must be a non-negative integer, got ${Text_From(index)}`);
  }
  const length = Array.isArray(target) ? target.length : target.rows.length;
  if (index >= length) {
    if (optional) return null;
    throw new MError(`item access: index ${index} out of range (${length} items)`);
  }
  return Array.isArray(target) ? target[index] : new MRecord(target.columns, target.rows[index]);
}

function callFn(f, args) {
  if (!(f instanceof MFunction)) throw new MError(`cannot call a ${typeName(f)} value`);
  if (args.length < f.minArgs || args.length > f.maxArgs) {
    const expected = f.minArgs === f.maxArgs ? `${f.minArgs}` : `${f.minArgs}-${f.maxArgs}`;
    throw new MError(`${f.name}: expected ${expected} arguments, got ${args.length}`);
  }
  const padded = args.slice();
  while (padded.length < f.maxArgs) padded.push(null);
  return f.impl(padded);
}

// ---------------------------------------------------------------------------
// Lexer

const KEYWORDS = new Set([
  'let', 'in', 'each', 'if', 'then', 'else', 'and', 'or', 'not', 'true', 'false', 'null', 'type', 'as',
]);
const TWO_CHAR_OPS = ['=>', '<=', '>=', '<>', '??'];
const ONE_CHAR_OPS = '=<>+-*/&(){}[],?';
const IDENT_RE = /[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}\p{N}_]+)*/uy;
const NUMBER_RE = /(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const GENERALIZED_RE = /[\p{L}\p{N}_][\p{L}\p{N}_. ]*/uy;
const HASH_WORD_RE = /#[A-Za-z]+/y;

class Lexer {
  constructor(src) {
    this.src = src;
    this.pos = 0;
  }

  error(message, pos = this.pos) {
    const before = this.src.slice(0, pos).split('\n');
    return new MError(`M parse error at line ${before.length}, column ${before.at(-1).length + 1}: ${message}`);
  }

  skipTrivia() {
    const s = this.src;
    for (;;) {
      while (this.pos < s.length && /\s/.test(s[this.pos])) this.pos++;
      if (s.startsWith('//', this.pos)) {
        const end = s.indexOf('\n', this.pos);
        this.pos = end < 0 ? s.length : end + 1;
      } else if (s.startsWith('/*', this.pos)) {
        const end = s.indexOf('*/', this.pos + 2);
        if (end < 0) throw this.error('unterminated comment');
        this.pos = end + 2;
      } else {
        return;
      }
    }
  }

  match(re) {
    re.lastIndex = this.pos;
    const m = re.exec(this.src);
    return m ? m[0] : null;
  }

  /** Reads a "..." literal starting at the opening quote; handles "" and #(...) escapes. */
  readQuoted() {
    const s = this.src;
    const start = this.pos;
    this.pos++;
    let out = '';
    for (;;) {
      if (this.pos >= s.length) throw this.error('unterminated text literal', start);
      const c = s[this.pos];
      if (c === '"') {
        if (s[this.pos + 1] === '"') {
          out += '"';
          this.pos += 2;
          continue;
        }
        this.pos++;
        return out;
      }
      if (c === '#' && s[this.pos + 1] === '(') {
        const end = s.indexOf(')', this.pos);
        if (end < 0) throw this.error('unterminated escape sequence');
        for (const part of s.slice(this.pos + 2, end).split(',')) {
          const name = part.trim();
          if (name === 'lf') out += '\n';
          else if (name === 'cr') out += '\r';
          else if (name === 'tab') out += '\t';
          else if (name === '#') out += '#';
          else if (/^(?:[0-9A-Fa-f]{4}|[0-9A-Fa-f]{8})$/.test(name)) out += String.fromCodePoint(parseInt(name, 16));
          else throw this.error(`invalid escape sequence '#(${name})'`);
        }
        this.pos = end + 1;
        continue;
      }
      out += c;
      this.pos++;
    }
  }

  next() {
    this.skipTrivia();
    const s = this.src;
    const pos = this.pos;
    if (pos >= s.length) return { t: 'eof', v: '', pos };
    const c = s[pos];
    if (c === '#' && s[pos + 1] === '"') {
      this.pos++;
      return { t: 'id', v: this.readQuoted(), quoted: true, pos };
    }
    if (c === '#') {
      const word = this.match(HASH_WORD_RE);
      if (word) {
        this.pos += word.length;
        return { t: 'id', v: word, pos };
      }
    }
    if (c === '"') return { t: 'text', v: this.readQuoted(), pos };
    const num = this.match(NUMBER_RE);
    if (num) {
      this.pos += num.length;
      return { t: 'num', v: Number(num), pos };
    }
    const id = this.match(IDENT_RE);
    if (id) {
      this.pos += id.length;
      return { t: KEYWORDS.has(id) ? 'kw' : 'id', v: id, pos };
    }
    const two = s.slice(pos, pos + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      this.pos += 2;
      return { t: 'op', v: two, pos };
    }
    if (ONE_CHAR_OPS.includes(c)) {
      this.pos++;
      return { t: 'op', v: c, pos };
    }
    throw this.error(`unexpected character '${c}'`);
  }

  /** Field name inside [...]: #"quoted" or a generalized identifier such as `Order Date` or `c.name`. */
  readGeneralizedName() {
    this.skipTrivia();
    if (this.src.startsWith('#"', this.pos)) {
      this.pos++;
      return this.readQuoted();
    }
    const raw = this.match(GENERALIZED_RE);
    if (!raw) return null;
    const name = raw.trimEnd();
    this.pos += name.length;
    return name;
  }
}

// ---------------------------------------------------------------------------
// Parser. AST nodes are plain objects tagged with `k`.

const describe = (tok) => (tok.t === 'eof' ? 'end of input' : `'${tok.v}'`);

class Parser {
  constructor(src) {
    this.lex = new Lexer(src);
    this.tok = null; // one-token lookahead, lexed lazily
  }

  peek() {
    if (!this.tok) this.tok = this.lex.next();
    return this.tok;
  }

  take() {
    const t = this.peek();
    this.tok = null;
    return t;
  }

  isOp(v) {
    const t = this.peek();
    return t.t === 'op' && t.v === v;
  }

  isKw(v) {
    const t = this.peek();
    return t.t === 'kw' && t.v === v;
  }

  fail(message, tok = this.peek()) {
    throw this.lex.error(`${message}, found ${describe(tok)}`, tok.pos);
  }

  expectOp(v) {
    if (!this.isOp(v)) this.fail(`expected '${v}'`);
    this.take();
  }

  expectKw(v) {
    if (!this.isKw(v)) this.fail(`expected '${v}'`);
    this.take();
  }

  save() {
    return { pos: this.lex.pos, tok: this.tok };
  }

  restore(state) {
    this.lex.pos = state.pos;
    this.tok = state.tok;
  }

  generalizedName() {
    if (this.tok) {
      this.lex.pos = this.tok.pos;
      this.tok = null;
    }
    return this.lex.readGeneralizedName();
  }

  parseProgram() {
    const e = this.parseExpression();
    if (this.peek().t !== 'eof') this.fail('expected end of input');
    return e;
  }

  parseExpression() {
    if (this.isKw('let')) return this.parseLet();
    if (this.isKw('if')) {
      this.take();
      const c = this.parseExpression();
      this.expectKw('then');
      const t = this.parseExpression();
      this.expectKw('else');
      return { k: 'if', c, t, e: this.parseExpression() };
    }
    if (this.isKw('each')) {
      this.take();
      return { k: 'fn', params: [{ name: '_', optional: false }], body: this.parseExpression() };
    }
    if (this.isOp('(')) {
      const fn = this.tryFunction();
      if (fn) return fn;
    }
    return this.parseCoalesce();
  }

  parseLet() {
    this.expectKw('let');
    const binds = [];
    for (;;) {
      const name = this.take();
      if (name.t !== 'id') this.fail('expected a variable name', name);
      this.expectOp('=');
      binds.push([name.v, this.parseExpression()]);
      if (!this.isOp(',')) break;
      this.take();
    }
    this.expectKw('in');
    return { k: 'let', binds, body: this.parseExpression() };
  }

  /** `(a, optional b as number) as text => body`, or null (state restored) if not a function. */
  tryFunction() {
    const state = this.save();
    const params = [];
    try {
      this.expectOp('(');
      if (!this.isOp(')')) {
        for (;;) {
          let t = this.take();
          let optional = false;
          if (t.t === 'id' && !t.quoted && t.v === 'optional' && this.peek().t === 'id') {
            optional = true;
            t = this.take();
          }
          if (t.t !== 'id') this.fail('not a parameter', t);
          if (this.isKw('as')) {
            this.take();
            this.parseTypeName();
          }
          params.push({ name: t.v, optional });
          if (!this.isOp(',')) break;
          this.take();
        }
      }
      this.expectOp(')');
      if (this.isKw('as')) {
        this.take();
        this.parseTypeName();
      }
      this.expectOp('=>');
    } catch (e) {
      if (!(e instanceof MError)) throw e;
      this.restore(state);
      return null;
    }
    return { k: 'fn', params, body: this.parseExpression() };
  }

  parseTypeName() {
    let nullable = false;
    if (this.peek().t === 'id' && this.peek().v === 'nullable') {
      this.take();
      nullable = true;
    }
    const t = this.take();
    if (!(t.t === 'id' && !t.quoted) && !(t.t === 'kw' && t.v === 'null')) this.fail('expected a type name', t);
    if (this.isOp('[') || this.isOp('{')) this.fail('unsupported type expression');
    return new MType(t.v, nullable);
  }

  parseCoalesce() {
    const l = this.parseOr();
    if (!this.isOp('??')) return l;
    this.take();
    return { k: 'bin', op: '??', l, r: this.parseCoalesce() };
  }

  parseOr() {
    let l = this.parseAnd();
    while (this.isKw('or')) {
      this.take();
      l = { k: 'bin', op: 'or', l, r: this.parseAnd() };
    }
    return l;
  }

  parseAnd() {
    let l = this.parseBinary(0);
    while (this.isKw('and')) {
      this.take();
      l = { k: 'bin', op: 'and', l, r: this.parseBinary(0) };
    }
    return l;
  }

  /** Levels, loosest first: equality, relational, additive, multiplicative. */
  parseBinary(level) {
    const LEVELS = [['=', '<>'], ['<', '>', '<=', '>='], ['+', '-', '&'], ['*', '/']];
    if (level === LEVELS.length) return this.parseUnary();
    let l = this.parseBinary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || !LEVELS[level].includes(t.v)) return l;
      this.take();
      l = { k: 'bin', op: t.v, l, r: this.parseBinary(level + 1) };
    }
  }

  parseUnary() {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.take().v;
      return { k: 'un', op, x: this.parseUnary() };
    }
    if (this.isKw('not')) {
      this.take();
      return { k: 'un', op: 'not', x: this.parseUnary() };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  parsePrimary() {
    const t = this.peek();
    if (t.t === 'num' || t.t === 'text') {
      this.take();
      return { k: 'lit', v: t.v };
    }
    if (t.t === 'id') {
      this.take();
      return { k: 'id', name: t.v };
    }
    if (t.t === 'kw') {
      switch (t.v) {
        case 'true': this.take(); return { k: 'lit', v: true };
        case 'false': this.take(); return { k: 'lit', v: false };
        case 'null': this.take(); return { k: 'lit', v: null };
        case 'type': this.take(); return { k: 'lit', v: this.parseTypeName() };
        case 'let':
        case 'if':
        case 'each':
          return this.parseExpression();
      }
    }
    if (this.isOp('(')) {
      const fn = this.tryFunction();
      if (fn) return fn;
      this.take();
      const e = this.parseExpression();
      this.expectOp(')');
      return e;
    }
    if (this.isOp('{')) {
      this.take();
      const items = [];
      if (!this.isOp('}')) {
        for (;;) {
          items.push(this.parseExpression());
          if (!this.isOp(',')) break;
          this.take();
        }
      }
      this.expectOp('}');
      return { k: 'list', items };
    }
    if (this.isOp('[')) {
      this.take();
      const first = this.generalizedName();
      if (first === null) {
        this.expectOp(']');
        return { k: 'rec', fields: [] };
      }
      if (this.isOp(']')) {
        this.take();
        return { k: 'field', target: null, name: first, opt: this.takeOptionalMark() };
      }
      const fields = [];
      let name = first;
      for (;;) {
        this.expectOp('=');
        fields.push([name, this.parseExpression()]);
        if (!this.isOp(',')) break;
        this.take();
        name = this.generalizedName();
        if (name === null) this.fail('expected a field name');
      }
      this.expectOp(']');
      return { k: 'rec', fields };
    }
    this.fail('expected an expression');
  }

  takeOptionalMark() {
    if (!this.isOp('?')) return false;
    this.take();
    return true;
  }

  parsePostfix(e) {
    for (;;) {
      if (this.isOp('[')) {
        this.take();
        const name = this.generalizedName();
        if (name === null) this.fail('expected a field name');
        this.expectOp(']');
        e = { k: 'field', target: e, name, opt: this.takeOptionalMark() };
      } else if (this.isOp('{')) {
        this.take();
        const index = this.parseExpression();
        this.expectOp('}');
        e = { k: 'item', target: e, index, opt: this.takeOptionalMark() };
      } else if (this.isOp('(')) {
        this.take();
        const args = [];
        if (!this.isOp(')')) {
          for (;;) {
            args.push(this.parseExpression());
            if (!this.isOp(',')) break;
            this.take();
          }
        }
        this.expectOp(')');
        e = { k: 'call', fn: e, args };
      } else {
        return e;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluator

class Env {
  constructor(parent, resolveGlobal) {
    this.parent = parent;
    this.resolveGlobal = resolveGlobal;
    this.vars = new Map();
  }

  define(name, value) {
    this.vars.set(name, { state: 'done', value });
  }

  defineLazy(name, expr, env) {
    if (this.vars.has(name)) throw new MError(`let: duplicate variable '${name}'`);
    this.vars.set(name, { state: 'pending', expr, env });
  }

  lookup(name) {
    for (let env = this; env; env = env.parent) {
      const slot = env.vars.get(name);
      if (!slot) continue;
      if (slot.state === 'done') return slot.value;
      if (slot.state === 'running') throw new MError(`cyclic reference to '${name}'`);
      slot.state = 'running';
      try {
        slot.value = ev(slot.expr, slot.env);
      } catch (e) {
        slot.state = 'pending';
        throw e;
      }
      slot.state = 'done';
      return slot.value;
    }
    return this.resolveGlobal(name);
  }
}

function ev(n, env) {
  switch (n.k) {
    case 'lit':
      return n.v;
    case 'id':
      return env.lookup(n.name);
    case 'let': {
      const inner = new Env(env, env.resolveGlobal);
      for (const [name, expr] of n.binds) inner.defineLazy(name, expr, inner);
      return ev(n.body, inner);
    }
    case 'list':
      return n.items.map((item) => ev(item, env));
    case 'rec':
      return new MRecord(n.fields.map((f) => f[0]), n.fields.map((f) => ev(f[1], env)));
    case 'field': {
      let target;
      if (n.target) target = ev(n.target, env);
      else {
        try {
          target = env.lookup('_');
        } catch (e) {
          if (!(e instanceof MError)) throw e;
          throw new MError(`implicit field access [${n.name}] used outside of 'each'`);
        }
      }
      return fieldAccess(target, n.name, n.opt);
    }
    case 'item':
      return itemAccess(ev(n.target, env), ev(n.index, env), n.opt);
    case 'call': {
      const f = ev(n.fn, env);
      return callFn(f, n.args.map((a) => ev(a, env)));
    }
    case 'fn': {
      const required = n.params.filter((p) => !p.optional).length;
      return new MFunction('function', required, n.params.length, (args) => {
        const inner = new Env(env, env.resolveGlobal);
        n.params.forEach((p, i) => inner.define(p.name, args[i]));
        return ev(n.body, inner);
      });
    }
    case 'if': {
      const c = ev(n.c, env);
      if (c === true) return ev(n.t, env);
      if (c === false) return ev(n.e, env);
      throw new MError(`if: cannot convert ${c === null ? 'null' : `a ${typeName(c)} value`} to Logical`);
    }
    case 'un': {
      const x = ev(n.x, env);
      if (x === null) return null;
      if (n.op === 'not') {
        if (typeof x !== 'boolean') throw new MError(`operator not: expected logical, got ${typeName(x)}`);
        return !x;
      }
      if (typeof x !== 'number') throw new MError(`unary ${n.op}: expected number, got ${typeName(x)}`);
      return n.op === '-' ? -x : x;
    }
    case 'bin':
      return evalBinary(n, env);
  }
  throw new MError(`internal: unknown node ${n.k}`);
}

function evalBinary(n, env) {
  const { op } = n;
  if (op === '??') {
    const l = ev(n.l, env);
    return l !== null ? l : ev(n.r, env);
  }
  if (op === 'and') {
    const l = checkLogical(op, ev(n.l, env));
    if (l === false) return false;
    const r = checkLogical(op, ev(n.r, env));
    if (l === true) return r;
    return r === false ? false : null;
  }
  if (op === 'or') {
    const l = checkLogical(op, ev(n.l, env));
    if (l === true) return true;
    const r = checkLogical(op, ev(n.r, env));
    if (l === false) return r;
    return r === true ? true : null;
  }
  const l = ev(n.l, env);
  const r = ev(n.r, env);
  switch (op) {
    case '=': return mEquals(l, r);
    case '<>': return !mEquals(l, r);
    case '<':
    case '>':
    case '<=':
    case '>=':
      return relational(op, l, r);
    case '&': return concat(l, r);
    default: return arithmetic(op, l, r);
  }
}

// ---------------------------------------------------------------------------
// Library

const LIB = new Map();

function def(name, minArgs, maxArgs, impl) {
  LIB.set(name, new MFunction(name, minArgs, maxArgs, impl));
}

const JOIN_KIND = { Inner: 0, LeftOuter: 1, RightOuter: 2, FullOuter: 3, LeftAnti: 4, RightAnti: 5 };
const ORDER = { Ascending: 0, Descending: 1 };
// Same numeric values as the real RoundingMode enumeration.
const ROUNDING = { Up: 0, Down: 1, AwayFromZero: 2, TowardZero: 3, ToEven: 4 };

for (const [group, values] of [['JoinKind', JOIN_KIND], ['Order', ORDER], ['RoundingMode', ROUNDING]]) {
  for (const [name, value] of Object.entries(values)) LIB.set(`${group}.${name}`, value);
}
for (const name of ['Int64', 'Int32', 'Number', 'Text', 'Logical', 'Date', 'DateTime', 'Currency', 'Decimal', 'Double']) {
  LIB.set(`${name}.Type`, new MType(name, false));
}

function argError(fname, what, v) {
  return new MError(`${fname}: expected ${what}, got ${typeName(v)}`);
}

function asTable(v, fname) {
  if (!(v instanceof MTable)) throw argError(fname, 'a table', v);
  return v;
}

function asList(v, fname) {
  if (!Array.isArray(v)) throw argError(fname, 'a list', v);
  return v;
}

function asText(v, fname) {
  if (typeof v !== 'string') throw argError(fname, 'text', v);
  return v;
}

function asNumber(v, fname) {
  if (typeof v !== 'number') throw argError(fname, 'a number', v);
  return v;
}

function asCount(v, fname) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new MError(`${fname}: expected a non-negative integer, got ${v === null ? 'null' : Text_From(v)}`);
  }
  return v;
}

function asFunction(v, fname) {
  if (!(v instanceof MFunction)) throw argError(fname, 'a function', v);
  return v;
}

/** A column-name argument: text or list of text. */
function asNames(v, fname) {
  if (typeof v === 'string') return [v];
  return asList(v, fname).map((x) => asText(x, fname));
}

function colIndex(t, name, fname) {
  const i = t.columns.indexOf(name);
  if (i < 0) throw new MError(`${fname}: column '${name}' not found (columns: ${t.columns.join(', ')})`);
  return i;
}

function checkUnique(names, fname) {
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) throw new MError(`${fname}: duplicate column '${n}'`);
    seen.add(n);
  }
}

const rowRecord = (t, row) => new MRecord(t.columns, row);

// --- #table, #date, #datetime

def('#table', 2, 2, ([columns, rows]) => {
  const N = '#table';
  const cols = asNames(asList(columns, N), N);
  const data = asList(rows, N).map((row) => {
    asList(row, N);
    if (row.length !== cols.length) {
      throw new MError(`${N}: row has ${row.length} values but there are ${cols.length} columns`);
    }
    return row;
  });
  return new MTable(cols, data);
});

def('#date', 3, 3, ([y, m, d]) => new MDate(asNumber(y, '#date'), asNumber(m, '#date'), asNumber(d, '#date')));

def('#datetime', 6, 6, (args) => new MDateTime(...args.map((a) => asNumber(a, '#datetime'))));

// --- Table functions

def('Table.SelectRows', 2, 2, ([t, pred]) => {
  const N = 'Table.SelectRows';
  asTable(t, N);
  asFunction(pred, N);
  return new MTable(t.columns, t.rows.filter((row) => {
    const keep = callFn(pred, [rowRecord(t, row)]);
    if (keep === null || typeof keep === 'boolean') return keep === true;
    throw new MError(`${N}: predicate returned ${typeName(keep)}, expected logical`);
  }));
});

def('Table.SelectColumns', 2, 2, ([t, cols]) => {
  const N = 'Table.SelectColumns';
  asTable(t, N);
  const names = asNames(cols, N);
  checkUnique(names, N);
  const idx = names.map((c) => colIndex(t, c, N));
  return new MTable(names, t.rows.map((row) => idx.map((i) => row[i])));
});

def('Table.RemoveColumns', 2, 2, ([t, cols]) => {
  const N = 'Table.RemoveColumns';
  asTable(t, N);
  const drop = new Set(asNames(cols, N).map((c) => colIndex(t, c, N)));
  const keep = t.columns.map((_, i) => i).filter((i) => !drop.has(i));
  return new MTable(keep.map((i) => t.columns[i]), t.rows.map((row) => keep.map((i) => row[i])));
});

// The listed columns are placed, in list order, into the positions those columns
// occupied; unlisted columns keep their positions (matches the documented example).
def('Table.ReorderColumns', 2, 2, ([t, cols]) => {
  const N = 'Table.ReorderColumns';
  asTable(t, N);
  const names = asNames(cols, N);
  checkUnique(names, N);
  const listed = names.map((c) => colIndex(t, c, N));
  const slots = [...listed].sort((a, b) => a - b);
  const order = t.columns.map((_, i) => i);
  slots.forEach((slot, k) => { order[slot] = listed[k]; });
  return new MTable(order.map((i) => t.columns[i]), t.rows.map((row) => order.map((i) => row[i])));
});

// Decision: renames apply simultaneously, so {{"a","b"},{"b","a"}} swaps names.
def('Table.RenameColumns', 2, 2, ([t, renames]) => {
  const N = 'Table.RenameColumns';
  asTable(t, N);
  asList(renames, N);
  const pairs = renames.length > 0 && typeof renames[0] === 'string' ? [renames] : renames;
  const columns = t.columns.slice();
  const renamed = new Set();
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new MError(`${N}: each rename must be {"old", "new"}`);
    const [from, to] = pair.map((x) => asText(x, N));
    const i = colIndex(t, from, N);
    if (renamed.has(i)) throw new MError(`${N}: column '${from}' renamed twice`);
    renamed.add(i);
    columns[i] = to;
  }
  checkUnique(columns, N);
  return new MTable(columns, t.rows);
});

def('Table.AddColumn', 3, 4, ([t, name, fn]) => {
  const N = 'Table.AddColumn';
  asTable(t, N);
  asText(name, N);
  asFunction(fn, N);
  if (t.columns.includes(name)) throw new MError(`${N}: column '${name}' already exists`);
  return new MTable([...t.columns, name], t.rows.map((row) => [...row, callFn(fn, [rowRecord(t, row)])]));
});

def('Table.NestedJoin', 5, 6, ([t1, k1, t2, k2, name, kind]) => {
  const N = 'Table.NestedJoin';
  asTable(t1, N);
  asTable(t2, N);
  asText(name, N);
  const keys1 = asNames(k1, N).map((c) => colIndex(t1, c, N));
  const keys2 = asNames(k2, N).map((c) => colIndex(t2, c, N));
  if (keys1.length !== keys2.length) throw new MError(`${N}: key lists have different lengths`);
  if (t1.columns.includes(name)) throw new MError(`${N}: column '${name}' already exists`);
  const joinKind = kind === null ? JOIN_KIND.LeftOuter : asNumber(kind, N);
  if (!Object.values(JOIN_KIND).includes(joinKind)) throw new MError(`${N}: invalid join kind ${joinKind}`);

  // Index the right table: hashable key tuples by hash, the rest scanned linearly.
  const rightKeys = t2.rows.map((row) => keys2.map((i) => row[i]));
  const byHash = new Map();
  rightKeys.forEach((key, r) => {
    const h = hashKey(key);
    if (h === null) return;
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(r);
  });
  const matchesFor = (key) => {
    const h = hashKey(key);
    if (h !== null) return byHash.get(h) ?? [];
    return rightKeys.flatMap((rk, r) => (tupleEquals(key, rk) ? [r] : []));
  };

  const matched = new Array(t2.rows.length).fill(false);
  const out = [];
  for (const row of t1.rows) {
    const matches = matchesFor(keys1.map((i) => row[i]));
    for (const r of matches) matched[r] = true;
    const keep = joinKind === JOIN_KIND.LeftOuter || joinKind === JOIN_KIND.FullOuter
      || (joinKind === JOIN_KIND.LeftAnti && matches.length === 0)
      || ((joinKind === JOIN_KIND.Inner || joinKind === JOIN_KIND.RightOuter) && matches.length > 0);
    if (keep) out.push([...row, new MTable(t2.columns, matches.map((r) => t2.rows[r]))]);
  }
  if (joinKind === JOIN_KIND.RightOuter || joinKind === JOIN_KIND.FullOuter || joinKind === JOIN_KIND.RightAnti) {
    const nulls = t1.columns.map(() => null);
    t2.rows.forEach((row, r) => {
      if (!matched[r]) out.push([...nulls, new MTable(t2.columns, [row])]);
    });
  }
  return new MTable([...t1.columns, name], out);
});

def('Table.ExpandTableColumn', 3, 4, ([t, column, names, newNames]) => {
  const N = 'Table.ExpandTableColumn';
  asTable(t, N);
  const ci = colIndex(t, asText(column, N), N);
  const inner = asNames(names, N);
  const outer = newNames === null ? inner : asNames(newNames, N);
  if (outer.length !== inner.length) throw new MError(`${N}: new column names list has a different length`);
  const others = t.columns.filter((_, i) => i !== ci);
  for (const n of outer) {
    if (others.includes(n)) throw new MError(`${N}: expanded column '${n}' collides with an existing column`);
  }
  checkUnique(outer, N);
  const nullCells = inner.map(() => null);
  const out = [];
  for (const row of t.rows) {
    const before = row.slice(0, ci);
    const after = row.slice(ci + 1);
    const nested = row[ci];
    if (nested === null) {
      out.push([...before, ...nullCells, ...after]);
      continue;
    }
    if (!(nested instanceof MTable)) throw new MError(`${N}: cell of column '${column}' is ${typeName(nested)}, expected table`);
    const idx = inner.map((n) => colIndex(nested, n, N));
    // An empty nested table still yields one row, with nulls (real Power Query behaviour).
    if (nested.rows.length === 0) out.push([...before, ...nullCells, ...after]);
    for (const r of nested.rows) out.push([...before, ...idx.map((i) => r[i]), ...after]);
  }
  return new MTable([...t.columns.slice(0, ci), ...outer, ...t.columns.slice(ci + 1)], out);
});

def('Table.Group', 3, 3, ([t, keys, aggregations]) => {
  const N = 'Table.Group';
  asTable(t, N);
  const keyNames = asNames(keys, N);
  const keyIdx = keyNames.map((c) => colIndex(t, c, N));
  asList(aggregations, N);
  const aggs = (aggregations.length > 0 && typeof aggregations[0] === 'string' ? [aggregations] : aggregations)
    .map((a) => {
      if (!Array.isArray(a) || a.length < 2 || a.length > 3) {
        throw new MError(`${N}: each aggregation must be {"name", function} or {"name", function, type}`);
      }
      return { name: asText(a[0], N), fn: asFunction(a[1], N) };
    });
  const columns = [...keyNames, ...aggs.map((a) => a.name)];
  checkUnique(columns, N);
  const groups = groupBy(t.rows, (row) => keyIdx.map((i) => row[i]));
  return new MTable(columns, groups.map((g) => {
    const sub = new MTable(t.columns, g.items);
    return [...g.key, ...aggs.map((a) => callFn(a.fn, [sub]))];
  }));
});

function sortCriterion(c, t, fname) {
  let key = c;
  let order = ORDER.Ascending;
  if (Array.isArray(c)) {
    if (c.length !== 2) throw new MError(`${fname}: invalid sort criterion`);
    [key, order] = c;
    if (order !== ORDER.Ascending && order !== ORDER.Descending) {
      throw new MError(`${fname}: invalid sort order ${order === null ? 'null' : Text_From(order)}`);
    }
  }
  const sign = order === ORDER.Descending ? -1 : 1;
  if (typeof key === 'string') {
    const i = colIndex(t, key, fname);
    return { sign, keyOf: (row) => row[i] };
  }
  if (key instanceof MFunction) return { sign, keyOf: (row) => callFn(key, [rowRecord(t, row)]) };
  throw new MError(`${fname}: invalid sort criterion of type ${typeName(key)}`);
}

def('Table.Sort', 2, 2, ([t, criteria]) => {
  const N = 'Table.Sort';
  asTable(t, N);
  const single = !Array.isArray(criteria)
    || (criteria.length === 2 && typeof criteria[1] === 'number'
      && (typeof criteria[0] === 'string' || criteria[0] instanceof MFunction));
  const specs = (single ? [criteria] : criteria).map((c) => sortCriterion(c, t, N));
  const keyed = t.rows.map((row) => ({ row, keys: specs.map((s) => s.keyOf(row)) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < specs.length; i++) {
      const c = sortCompare(a.keys[i], b.keys[i], N);
      if (c !== 0) return c * specs[i].sign;
    }
    return 0;
  });
  return new MTable(t.columns, keyed.map((k) => k.row));
});

def('Table.Distinct', 1, 1, ([t]) => {
  asTable(t, 'Table.Distinct');
  return new MTable(t.columns, groupBy(t.rows, (row) => row).map((g) => g.items[0]));
});

def('Table.Combine', 1, 1, ([tables]) => {
  const N = 'Table.Combine';
  const list = asList(tables, N).map((t) => asTable(t, N));
  const columns = [];
  for (const t of list) for (const c of t.columns) if (!columns.includes(c)) columns.push(c);
  const rows = [];
  for (const t of list) {
    const idx = columns.map((c) => t.columns.indexOf(c));
    for (const row of t.rows) rows.push(idx.map((i) => (i < 0 ? null : row[i])));
  }
  return new MTable(columns, rows);
});

def('Table.FirstN', 2, 2, ([t, n]) => {
  asTable(t, 'Table.FirstN');
  return new MTable(t.columns, t.rows.slice(0, asCount(n, 'Table.FirstN')));
});

def('Table.Skip', 1, 2, ([t, n]) => {
  asTable(t, 'Table.Skip');
  return new MTable(t.columns, t.rows.slice(n === null ? 1 : asCount(n, 'Table.Skip')));
});

def('Table.RowCount', 1, 1, ([t]) => asTable(t, 'Table.RowCount').rows.length);
def('Table.IsEmpty', 1, 1, ([t]) => asTable(t, 'Table.IsEmpty').rows.length === 0);
def('Table.ColumnNames', 1, 1, ([t]) => asTable(t, 'Table.ColumnNames').columns.slice());

def('Table.AddIndexColumn', 2, 5, ([t, name, start, step]) => {
  const N = 'Table.AddIndexColumn';
  asTable(t, N);
  const from = start === null ? 0 : asNumber(start, N);
  const by = step === null ? 1 : asNumber(step, N);
  return new MTable([...t.columns, asText(name, N)], t.rows.map((row, i) => [...row, from + i * by]));
});
// Buffering only pins evaluation in Power Query; values are unchanged.
def('Table.Buffer', 1, 2, ([t]) => asTable(t, 'Table.Buffer'));
def('List.Buffer', 1, 1, ([list]) => asList(list, 'List.Buffer'));
def('List.Range', 2, 3, ([list, offset, count]) => {
  const N = 'List.Range';
  const xs = asList(list, N);
  const from = asCount(offset, N);
  if (from > xs.length) throw new MError(`${N}: offset ${from} is past the end of a list of ${xs.length}`);
  return count === null ? xs.slice(from) : xs.slice(from, from + asCount(count, N));
});

// --- List functions

function nonNullNumbers(list, fname) {
  return asList(list, fname).filter((x) => x !== null).map((x) => asNumber(x, fname));
}

def('List.Sum', 1, 1, ([list]) => {
  const xs = nonNullNumbers(list, 'List.Sum');
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0);
});

def('List.Average', 1, 1, ([list]) => {
  const xs = nonNullNumbers(list, 'List.Average');
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
});

for (const [name, sign] of [['List.Min', -1], ['List.Max', 1]]) {
  def(name, 1, 1, ([list]) => {
    const xs = asList(list, name).filter((x) => x !== null);
    if (xs.length === 0) return null;
    return xs.reduce((best, x) => (sortCompare(x, best, name) * sign > 0 ? x : best));
  });
}

def('List.Count', 1, 1, ([list]) => asList(list, 'List.Count').length);
def('List.NonNullCount', 1, 1, ([list]) => asList(list, 'List.NonNullCount').filter((x) => x !== null).length);
def('List.Distinct', 1, 1, ([list]) => groupBy(asList(list, 'List.Distinct'), (x) => [x]).map((g) => g.items[0]));
def('List.RemoveNulls', 1, 1, ([list]) => asList(list, 'List.RemoveNulls').filter((x) => x !== null));
def('List.Contains', 2, 2, ([list, value]) => asList(list, 'List.Contains').some((x) => mEquals(x, value)));
def('List.Transform', 2, 2, ([list, fn]) => {
  asFunction(fn, 'List.Transform');
  return asList(list, 'List.Transform').map((x) => callFn(fn, [x]));
});

// --- Text functions (null text input gives null)

function textFn(name, minArgs, maxArgs, impl) {
  def(name, minArgs, maxArgs, (args) => (args[0] === null ? null : impl(asText(args[0], name), ...args.slice(1))));
}

textFn('Text.Upper', 1, 2, (s) => s.toUpperCase());
textFn('Text.Lower', 1, 2, (s) => s.toLowerCase());
textFn('Text.Trim', 1, 1, (s) => s.trim());
textFn('Text.TrimStart', 1, 1, (s) => s.trimStart());
textFn('Text.TrimEnd', 1, 1, (s) => s.trimEnd());
textFn('Text.Length', 1, 1, (s) => s.length);
// Decision: offsets/counts past the end clamp (like Text.Middle); negative values error.
textFn('Text.Middle', 2, 3, (s, start, count) => {
  const from = asCount(start, 'Text.Middle');
  return count === null ? s.slice(from) : s.slice(from, from + asCount(count, 'Text.Middle'));
});
textFn('Text.Start', 2, 2, (s, n) => s.slice(0, asCount(n, 'Text.Start')));
textFn('Text.End', 2, 2, (s, n) => {
  const count = asCount(n, 'Text.End');
  return count === 0 ? '' : s.slice(-count);
});
textFn('Text.Replace', 3, 3, (s, oldText, newText) => {
  const from = asText(oldText, 'Text.Replace');
  if (from === '') throw new MError('Text.Replace: old text must not be empty');
  return s.split(from).join(asText(newText, 'Text.Replace'));
});
// Decision: the search text must be text (null search text errors).
textFn('Text.Contains', 2, 3, (s, sub) => s.includes(asText(sub, 'Text.Contains')));
textFn('Text.StartsWith', 2, 3, (s, sub) => s.startsWith(asText(sub, 'Text.StartsWith')));
textFn('Text.EndsWith', 2, 3, (s, sub) => s.endsWith(asText(sub, 'Text.EndsWith')));

function Text_From(v) {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof MDate || v instanceof MDateTime) return v.toString();
  throw argError('Text.From', 'a primitive value', v);
}
def('Text.From', 1, 2, ([v]) => Text_From(v));

def('Text.Combine', 1, 2, ([list, sep]) => {
  const N = 'Text.Combine';
  const parts = asList(list, N).filter((x) => x !== null).map((x) => asText(x, N));
  return parts.join(sep === null ? '' : asText(sep, N));
});

// --- Number functions (null input gives null)

const NUMBER_TEXT_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseNumberText(s, fname) {
  const trimmed = s.trim();
  if (!NUMBER_TEXT_RE.test(trimmed)) throw new MError(`${fname}: cannot convert text '${s}' to a number`);
  return Number(trimmed);
}

function toNumber(v, fname) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseNumberText(v, fname);
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw argError(fname, 'a number, text or logical', v);
}

/**
 * x * 10^d computed on the shortest decimal representation of x, so that 2.675
 * shifts to exactly 267.5 instead of 267.49999999999997. This makes rounding act on
 * the decimal value the user sees (2.675 rounds AwayFromZero to 2.68), which is
 * what a DECIMAL-typed DuckDB column produces.
 */
function shiftDecimal(x, d) {
  const [mantissa, exponent] = String(x).split('e');
  return Number(`${mantissa}e${Number(exponent ?? 0) + d}`);
}

function roundNumber(x, digits, mode, fname) {
  if (!Number.isInteger(digits)) throw new MError(`${fname}: digits must be an integer`);
  if (!Number.isFinite(x)) return x;
  const y = shiftDecimal(x, digits);
  const sign = Math.sign(y);
  const a = Math.abs(y);
  const f = Math.floor(a);
  const frac = a - f;
  let r;
  switch (mode) {
    case ROUNDING.Up: r = Math.ceil(y); break;
    case ROUNDING.Down: r = Math.floor(y); break;
    case ROUNDING.TowardZero: r = Math.trunc(y); break;
    case ROUNDING.AwayFromZero: r = sign * (frac >= 0.5 ? f + 1 : f); break;
    case ROUNDING.ToEven: r = sign * (frac > 0.5 || (frac === 0.5 && f % 2 === 1) ? f + 1 : f); break;
    default: throw new MError(`${fname}: invalid rounding mode ${mode}`);
  }
  return shiftDecimal(r, -digits) + 0; // + 0 turns -0 into 0
}

function numberFn(name, minArgs, maxArgs, impl) {
  def(name, minArgs, maxArgs, (args) => (args[0] === null ? null : impl(asNumber(args[0], name), ...args.slice(1))));
}

def('Number.From', 1, 2, ([v]) => (v === null ? null : toNumber(v, 'Number.From')));
numberFn('Number.Abs', 1, 1, (x) => Math.abs(x));
numberFn('Number.Round', 1, 3, (x, digits, mode) => roundNumber(
  x,
  digits === null ? 0 : asNumber(digits, 'Number.Round'),
  mode === null ? ROUNDING.ToEven : asNumber(mode, 'Number.Round'),
  'Number.Round',
));
numberFn('Number.RoundUp', 1, 2, (x, digits) => roundNumber(x, digits === null ? 0 : asNumber(digits, 'Number.RoundUp'), ROUNDING.Up, 'Number.RoundUp'));
numberFn('Number.RoundDown', 1, 2, (x, digits) => roundNumber(x, digits === null ? 0 : asNumber(digits, 'Number.RoundDown'), ROUNDING.Down, 'Number.RoundDown'));

// Decision: a zero divisor raises MError for Mod and IntegerDivide (as in Power Query)
// rather than returning NaN. A null divisor gives null.
function divisor(y, fname) {
  if (asNumber(y, fname) === 0) throw new MError(`${fname}: division by zero`);
  return y;
}
numberFn('Number.Mod', 2, 3, (x, y) => (y === null ? null : x % divisor(y, 'Number.Mod')));
numberFn('Number.IntegerDivide', 2, 3, (x, y) => (y === null ? null : Math.trunc(x / divisor(y, 'Number.IntegerDivide')) + 0));

def('Int64.From', 1, 3, ([v, , mode]) => {
  const N = 'Int64.From';
  if (v === null) return null;
  return roundNumber(toNumber(v, N), 0, mode === null ? ROUNDING.ToEven : asNumber(mode, N), N);
});

// --- Logical and Date

def('Logical.From', 1, 1, ([v]) => {
  const N = 'Logical.From';
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const lower = v.trim().toLowerCase();
    if (lower === 'true' || lower === 'false') return lower === 'true';
    throw new MError(`${N}: cannot convert text '${v}' to logical`);
  }
  throw argError(N, 'a logical, number or text', v);
});

def('Date.From', 1, 2, ([v]) => {
  const N = 'Date.From';
  if (v === null || v instanceof MDate) return v;
  if (v instanceof MDateTime) return new MDate(v.year, v.month, v.day);
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
    if (!m) throw new MError(`${N}: cannot convert text '${v}' to a date (expected YYYY-MM-DD)`);
    return new MDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  throw argError(N, 'a date, datetime or text', v);
});

for (const [name, field] of [['Date.Year', 'year'], ['Date.Month', 'month'], ['Date.Day', 'day']]) {
  def(name, 1, 1, ([v]) => {
    if (v === null) return null;
    if (v instanceof MDate || v instanceof MDateTime) return v[field];
    throw argError(name, 'a date or datetime', v);
  });
}

def('Date.AddDays', 2, 2, ([d, n]) => {
  const N = 'Date.AddDays';
  if (d === null) return null;
  if (!(d instanceof MDate)) throw argError(N, 'a date', d);
  if (!Number.isInteger(n)) throw argError(N, 'an integer', n);
  return dateFromDayNumber(dayNumber(d) + n);
});

def('Duration.Days', 1, 1, ([v]) => {
  if (v === null) return null;
  if (!(v instanceof MDuration)) throw argError('Duration.Days', 'a duration', v);
  return v.days;
});

// Only the two fixed formats the transpiler emits are supported.
function formatOption(opts, fname) {
  if (!(opts instanceof MRecord) || typeof opts.fields.get('Format') !== 'string') {
    throw new MError(`${fname}: expected an options record with Format`);
  }
  return opts.fields.get('Format');
}
def('Date.ToText', 2, 2, ([d, opts]) => {
  const N = 'Date.ToText';
  if (formatOption(opts, N) !== 'yyyy-MM-dd') throw new MError(`${N}: unsupported format`);
  if (d === null) return null;
  if (!(d instanceof MDate)) throw argError(N, 'a date', d);
  return d.toString();
});
def('DateTime.ToText', 2, 2, ([d, opts]) => {
  const N = 'DateTime.ToText';
  if (formatOption(opts, N) !== 'yyyy-MM-dd HH:mm:ss') throw new MError(`${N}: unsupported format`);
  if (d === null) return null;
  if (!(d instanceof MDateTime)) throw argError(N, 'a datetime', d);
  return `${d.toString().slice(0, 17)}${pad(Math.floor(d.second), 2)}`;
});

def('List.First', 1, 2, ([list, dflt]) => {
  const xs = asList(list, 'List.First');
  return xs.length === 0 ? dflt : xs[0];
});

def('Table.DuplicateColumn', 3, 4, ([t, column, newName]) => {
  const N = 'Table.DuplicateColumn';
  asTable(t, N);
  const ci = colIndex(t, asText(column, N), N);
  return new MTable([...t.columns, asText(newName, N)], t.rows.map((row) => [...row, row[ci]]));
});

// ---------------------------------------------------------------------------
// Entry point

function sourceTable(name, src) {
  if (!src || !Array.isArray(src.columns) || !Array.isArray(src.rows)) {
    throw new MError(`source '${name}' must be { columns: string[], rows: any[][] }`);
  }
  for (const row of src.rows) {
    if (!Array.isArray(row) || row.length !== src.columns.length) {
      throw new MError(`source '${name}': every row must have ${src.columns.length} values`);
    }
    for (const v of row) {
      if (v === undefined) throw new MError(`source '${name}': undefined cell (use null)`);
      typeName(v);
    }
  }
  return new MTable(src.columns.slice(), src.rows);
}

/**
 * Evaluates an M document whose value must be a table.
 * sources: { [queryName]: { columns: string[], rows: any[][] } } — other queries
 * referenced by name (e.g. `orders` or `#"order lines"`).
 * Returns { columns, rows } (fresh arrays). Throws MError on any M error.
 */
export function evaluateM(mText, sources = {}) {
  const tables = new Map();
  for (const [name, src] of Object.entries(sources)) tables.set(name, sourceTable(name, src));
  const resolveGlobal = (name) => {
    if (tables.has(name)) return tables.get(name);
    if (LIB.has(name)) return LIB.get(name);
    throw new MError(`unknown identifier '${name}'`);
  };
  const ast = new Parser(mText).parseProgram();
  const value = ev(ast, new Env(null, resolveGlobal));
  if (!(value instanceof MTable)) throw new MError(`the query must evaluate to a table, got ${typeName(value)}`);
  return { columns: value.columns.slice(), rows: value.rows.map((row) => row.slice()) };
}
