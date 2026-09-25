// Adversarial fake rows for empty tables.
//
// Every table draws from the same tiny domains, so joins collide the way real
// data does: duplicate keys, orphans, many-to-many matches, NULL keys, and
// text that differs only by case, padding, or quotes. Output is deterministic
// for a given (table name, seed) pair.

export interface Column {
  name: string;
  /** DuckDB `data_type` from information_schema.columns, e.g. `DECIMAL(10,2)`. */
  type: string;
}

export const ROWS_PER_TABLE = 12;
const NULL_RATE = 0.15;

const INTEGERS = ['1', '2', '3', '4', '5', '6'];
const TEXTS = ['alpha', 'Alpha', ' alpha', 'alpha ', 'beta', 'BETA', "o'neil", ''];
const DOUBLES = [0, 1.5, 10, 10, 99.99, -2.25];
const DATES = ['2024-01-31', '2024-02-29', '2024-03-01', '1999-12-31'];
const TIMESTAMPS = ['2024-01-31 00:00:00', '2024-01-31 23:59:59', '2024-02-29 12:00:00', '1999-12-31 23:59:59'];
const BOOLEANS = ['true', 'false'];

type Kind = 'integer' | 'float' | 'decimal' | 'text' | 'date' | 'boolean';

/** Base type name (before any parameters) → value domain. TIMESTAMP* is matched by prefix. */
const KIND_BY_TYPE: Record<string, Kind> = {
  TINYINT: 'integer', SMALLINT: 'integer', INTEGER: 'integer', BIGINT: 'integer', HUGEINT: 'integer',
  UTINYINT: 'integer', USMALLINT: 'integer', UINTEGER: 'integer', UBIGINT: 'integer', UHUGEINT: 'integer',
  INT: 'integer', INT1: 'integer', INT2: 'integer', INT4: 'integer', INT8: 'integer',
  SHORT: 'integer', LONG: 'integer', SIGNED: 'integer',
  DOUBLE: 'float', FLOAT: 'float', REAL: 'float', FLOAT4: 'float', FLOAT8: 'float',
  DECIMAL: 'decimal', NUMERIC: 'decimal',
  VARCHAR: 'text', TEXT: 'text', STRING: 'text', CHAR: 'text', BPCHAR: 'text', NVARCHAR: 'text',
  DATE: 'date',
  BOOLEAN: 'boolean', BOOL: 'boolean', LOGICAL: 'boolean',
};

/** mulberry32: small, fast, good enough for fake data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, 32-bit. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function sqlString(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

export function sqlIdent(name: string): string {
  return '"' + name.replaceAll('"', '""') + '"';
}

/** SQL literals (without NULL) that are valid for the column type, or null when the type is not handled. */
function domainFor(type: string): string[] | null {
  const t = type.trim().toUpperCase();
  const base = t.replace(/\(.*$/, '').trim();
  if (base.startsWith('TIMESTAMP')) return TIMESTAMPS.map((d) => `TIMESTAMP ${sqlString(d)}`);
  switch (KIND_BY_TYPE[base]) {
    case 'integer': return INTEGERS;
    case 'float': return DOUBLES.map(String);
    case 'decimal': return decimalDomain(t);
    case 'text': return TEXTS.map(sqlString);
    case 'date': return DATES.map((d) => `DATE ${sqlString(d)}`);
    case 'boolean': return BOOLEANS;
    default: return null;
  }
}

/** DOUBLES that fit DECIMAL(p,s) after rounding to s places (DuckDB's default is DECIMAL(18,3)). */
function decimalDomain(type: string): string[] {
  const m = /^\w+\((\d+)(?:,\s*(\d+))?\)$/.exec(type);
  const precision = m ? Number(m[1]) : 18;
  const scale = m ? Number(m[2] ?? 0) : 3;
  const limit = 10 ** (precision - scale);
  const fits = DOUBLES.filter((v) => Math.abs(Number(v.toFixed(scale))) < limit);
  return (fits.length > 0 ? fits : [0]).map((v) => v.toFixed(scale));
}

/** One column's values (SQL literals, 'NULL' for null). */
function columnValues(domain: string[] | null, rows: number, rand: () => number): string[] {
  if (domain === null) return new Array<string>(rows).fill('NULL');
  const values = Array.from({ length: rows }, () =>
    rand() < NULL_RATE ? 'NULL' : domain[Math.floor(rand() * domain.length)]!,
  );
  if (rows < 3) return values;

  // Guarantee at least one NULL and one duplicated non-null value, so every
  // column can exercise null-key and fan-out behaviour.
  if (!values.includes('NULL')) values[Math.floor(rand() * rows)] = 'NULL';
  const nonNull = values.flatMap((v, i) => (v === 'NULL' ? [] : [i]));
  const distinct = new Set(nonNull.map((i) => values[i]));
  if (distinct.size === nonNull.length && nonNull.length >= 2) {
    values[nonNull[1]!] = values[nonNull[0]!]!;
  }
  return values;
}

/** An INSERT statement filling `table` with adversarial rows, or '' if it has no columns. */
export function fakeInsert(table: string, columns: Column[], seed: number, rows = ROWS_PER_TABLE): string {
  if (columns.length === 0 || rows <= 0) return '';
  const rand = mulberry32(hash(`${table.toLowerCase()}:${seed}`));
  const byColumn = columns.map((c) => columnValues(domainFor(c.type), rows, rand));
  const tuples = Array.from({ length: rows }, (_, r) => '(' + byColumn.map((col) => col[r]).join(', ') + ')');
  const names = columns.map((c) => sqlIdent(c.name)).join(', ');
  return `INSERT INTO ${sqlIdent(table)} (${names}) VALUES\n  ${tuples.join(',\n  ')};`;
}
