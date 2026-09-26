import { Duck, errorMessage, type ResultTable } from './duck';
import { sqlIdent } from './fakedata';
import { highlight, lineNumbers } from './highlight';
import { transpile } from './generated/sql2m.js';

const DEFAULT_TABLES = `CREATE TABLE invoices (invoice_id INTEGER, customer_ref VARCHAR, amount DOUBLE, invoice_date DATE);
CREATE TABLE payments (payment_id INTEGER, customer_ref VARCHAR, amount DOUBLE, paid_on DATE);
`;

const DEFAULT_QUERY = `-- Waterfall match: exact, then loosened, then leftovers.
WITH exact AS (
  SELECT p.payment_id, i.invoice_id, 'exact' AS tier
  FROM payments p
  JOIN invoices i ON p.customer_ref = i.customer_ref AND p.amount = i.amount
),
rest1 AS (
  SELECT * FROM payments p ANTI JOIN exact e ON p.payment_id = e.payment_id
),
loose AS (
  SELECT r.payment_id, i.invoice_id, 'ref, case-insensitive' AS tier
  FROM rest1 r
  JOIN invoices i ON lower(trim(r.customer_ref)) = lower(trim(i.customer_ref))
),
rest2 AS (
  SELECT * FROM rest1 r ANTI JOIN loose l ON r.payment_id = l.payment_id
)
SELECT * FROM exact
UNION ALL SELECT * FROM loose
UNION ALL SELECT payment_id, NULL, 'unmatched' FROM rest2
`;

const RESULT_ROW_LIMIT = 200;
const DEBOUNCE_MS = 300;
// Arrow `Type` enum values (apache-arrow is only a transitive dependency).
const ARROW_DATE = 8;
const ARROW_TIMESTAMP = 10;

// `    #"Step Name" = …` or `    Step = …` at the top level of the let.
const STEP_LINE = /^ {4}(?:#"(?:[^"]|"")*"|[A-Za-z_][\w.]*) = /gm;

const STORAGE = { tables: 'sql2m.tables', query: 'sql2m.query', fill: 'sql2m.fill' } as const;

type TranspileResult = { ok: true; m: string; warnings?: string[] } | { ok: false; error: string };

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el as T;
}

const ui = {
  status: byId('status'),
  tables: byId<HTMLTextAreaElement>('tables'),
  query: byId<HTMLTextAreaElement>('query'),
  fill: byId<HTMLInputElement>('fill'),
  regenerate: byId<HTMLButtonElement>('regenerate'),
  seed: byId('seed'),
  tablesError: byId('tables-error'),
  copy: byId<HTMLButtonElement>('copy'),
  steps: byId('steps'),
  error: byId('error'),
  errorTitle: byId('error-title'),
  errorMessage: byId('error-message'),
  mView: byId('m-view'),
  mGutter: byId('m-gutter'),
  m: byId('m'),
  warningsBox: byId('warnings-box'),
  warningsCount: byId('warnings-count'),
  warnings: byId('warnings'),
  counts: byId('counts'),
  resultCount: byId('result-count'),
  resultError: byId('result-error'),
  result: byId('result'),
  previews: byId('previews'),
};

// ---------------------------------------------------------------- storage

function loadSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE.tables, ui.tables.value);
    localStorage.setItem(STORAGE.query, ui.query.value);
    localStorage.setItem(STORAGE.fill, ui.fill.checked ? '1' : '0');
  } catch {
    // Storage disabled or full: the page still works, it just won't remember.
  }
}

ui.tables.value = loadSetting(STORAGE.tables) ?? DEFAULT_TABLES;
ui.query.value = loadSetting(STORAGE.query) ?? DEFAULT_QUERY;
ui.fill.checked = loadSetting(STORAGE.fill) !== '0';

// ---------------------------------------------------------------- editors

// Each textarea is transparent over a highlighted <pre> of the same text.
function paintEditor(editor: HTMLTextAreaElement): void {
  const box = editor.closest('.editor');
  const hl = box?.querySelector<HTMLElement>('.hl');
  const gutter = box?.querySelector<HTMLElement>('.gutter');
  if (hl == null || gutter == null) return;
  // A trailing newline needs a character after it, or the <pre> drops the last line.
  highlight(hl, editor.value.endsWith('\n') || editor.value === '' ? editor.value + ' ' : editor.value, 'sql');
  gutter.textContent = lineNumbers(editor.value);
}

for (const editor of [ui.tables, ui.query]) {
  paintEditor(editor);
  editor.addEventListener('input', () => paintEditor(editor));
  let escaped = false;
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      escaped = true;
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !escaped) {
      e.preventDefault();
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    escaped = false;
  });
}

// ---------------------------------------------------------------- rendering

function formatDate(ms: number, withTime: boolean): string {
  const iso = new Date(ms).toISOString();
  if (!withTime) return iso.slice(0, 10);
  return iso.slice(0, 19).replace('T', ' ') + (iso.endsWith('.000Z') ? '' : iso.slice(19, 23));
}

function cell(value: unknown, typeId: number): HTMLTableCellElement {
  const td = document.createElement('td');
  if (value === null || value === undefined) {
    td.className = 'null';
    td.textContent = 'null';
    return td;
  }
  if ((typeId === ARROW_DATE || typeId === ARROW_TIMESTAMP) && (typeof value === 'number' || value instanceof Date)) {
    td.textContent = formatDate(Number(value), typeId === ARROW_TIMESTAMP);
    return td;
  }
  if (typeof value === 'string') {
    // Show leading/trailing spaces and empty strings: they are the point of the fake data.
    const span = document.createElement('span');
    span.className = value === '' ? 'str empty' : 'str';
    span.textContent = value === '' ? "''" : value;
    td.append(span);
    return td;
  }
  if (typeof value === 'number' || typeof value === 'bigint') td.className = 'num';
  td.textContent =
    typeof value === 'object' ? JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) : String(value);
  return td;
}

function renderTable(t: ResultTable, limit: number): HTMLTableElement {
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  const fields = t.schema.fields;
  for (const f of fields) {
    const th = document.createElement('th');
    th.textContent = f.name;
    head.append(th);
  }
  const body = table.createTBody();
  const columns = fields.map((_, i) => t.getChildAt(i));
  const rows = Math.min(t.numRows, limit);
  for (let r = 0; r < rows; r++) {
    const tr = body.insertRow();
    fields.forEach((f, i) => tr.append(cell(columns[i]?.get(r), f.typeId)));
  }
  return table;
}

function explain(el: HTMLElement, title: string, message: string): void {
  el.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = title;
  const p = document.createElement('p');
  p.textContent = message;
  el.append(strong, p);
  el.hidden = false;
}

function showTranspileError(title: string, message: string): void {
  ui.errorTitle.textContent = title;
  ui.errorMessage.textContent = message;
  ui.error.hidden = false;
  ui.mView.hidden = true;
  ui.m.textContent = '';
  ui.steps.textContent = '';
  ui.copy.disabled = true;
  ui.warningsBox.hidden = true;
}

function showM(m: string, warnings: string[]): void {
  ui.error.hidden = true;
  highlight(ui.m, m, 'm');
  ui.mGutter.textContent = lineNumbers(m);
  ui.mView.hidden = false;
  const steps = m.match(STEP_LINE)?.length ?? 0;
  ui.steps.textContent = `${steps} step${steps === 1 ? '' : 's'}`;
  ui.copy.disabled = false;
  ui.warnings.replaceChildren(
    ...warnings.map((w) => {
      const li = document.createElement('li');
      li.textContent = w;
      return li;
    }),
  );
  ui.warningsCount.textContent = String(warnings.length);
  ui.warningsBox.hidden = warnings.length === 0;
}

interface CountRow {
  kind: 'table' | 'view' | 'cte' | 'result';
  name: string;
  count?: number;
  error?: string;
}

function renderCounts(rows: CountRow[]): void {
  const max = Math.max(1, ...rows.map((r) => r.count ?? 0));
  ui.counts.replaceChildren(
    ...rows.map((row) => {
      const li = document.createElement('li');
      li.className = row.kind;
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = row.kind === 'result' ? '' : row.kind;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = row.kind === 'result' ? 'Result' : row.name;
      const n = document.createElement('span');
      n.className = row.error === undefined ? 'n' : 'n failed';
      n.textContent = row.error === undefined ? String(row.count) : 'error';
      if (row.error !== undefined) n.title = row.error;
      const bar = document.createElement('span');
      bar.className = 'bar';
      const fill = document.createElement('span');
      fill.style.width = `${Math.round(((row.count ?? 0) / max) * 100)}%`;
      bar.append(fill);
      li.append(kind, name, n, document.createElement('span'), bar);
      return li;
    }),
  );
}

// ---------------------------------------------------------------- pipeline

let duck: Duck | null = null;
let seed = 1;
let appliedKey: string | null = null;
let baseCounts: CountRow[] = [];
const openPreviews = new Set<string>();
let previewsShown = false;

async function applyTables(): Promise<void> {
  if (duck === null) return;
  ui.tablesError.hidden = true;
  try {
    await duck.applyTables(ui.tables.value, ui.fill.checked, seed);
  } catch (e) {
    explain(ui.tablesError, 'Tables script', errorMessage(e));
  }

  // Counts and previews reflect whatever exists now, even after a partial failure.
  baseCounts = [];
  const details: HTMLDetailsElement[] = [];
  for (const r of await duck.relations()) {
    const kind = r.isView ? 'view' : 'table';
    const d = document.createElement('details');
    // Keep previews open across refreshes; the first one starts open.
    d.open = openPreviews.has(r.name) || (!previewsShown && details.length === 0);
    if (d.open) openPreviews.add(r.name);
    d.addEventListener('toggle', () => (d.open ? openPreviews.add(r.name) : openPreviews.delete(r.name)));
    const summary = document.createElement('summary');
    try {
      const t = await duck.query(`SELECT * FROM ${sqlIdent(r.name)} LIMIT ${RESULT_ROW_LIMIT}`);
      const count = await duck.count(r.name);
      baseCounts.push({ kind, name: r.name, count });
      const rowsText = document.createElement('span');
      rowsText.className = 'faint';
      rowsText.textContent = `${count} row${count === 1 ? '' : 's'}`;
      summary.append(r.name, rowsText);
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      wrap.append(renderTable(t, RESULT_ROW_LIMIT));
      d.append(summary, wrap);
    } catch (e) {
      const error = errorMessage(e);
      baseCounts.push({ kind, name: r.name, error });
      const failed = document.createElement('span');
      failed.className = 'err';
      failed.textContent = 'error';
      summary.append(r.name, failed);
      const p = document.createElement('p');
      p.textContent = error;
      d.append(summary, p);
    }
    details.push(d);
  }
  ui.previews.replaceChildren(...details);
  previewsShown ||= details.length > 0;
}

function runTranspiler(astJson: string, catalogJson: string): void {
  let result: TranspileResult;
  try {
    result = JSON.parse(transpile(astJson, catalogJson)) as TranspileResult;
  } catch (e) {
    showTranspileError('Transpiler error', `The transpiler failed unexpectedly: ${errorMessage(e)}`);
    return;
  }
  if (result.ok) showM(result.m, result.warnings ?? []);
  else showTranspileError('Not translated', result.error);
}

async function update(): Promise<void> {
  if (duck === null) return;
  const key = `${ui.fill.checked}\u0000${seed}\u0000${ui.tables.value}`;
  if (key !== appliedKey) {
    appliedKey = key;
    await applyTables();
  }

  const sql = ui.query.value;
  const astJson = await duck.serialize(sql);
  const parsed = JSON.parse(astJson) as { error?: boolean; error_message?: string };
  ui.resultError.hidden = true;
  if (parsed.error === true) {
    showTranspileError('SQL parser', parsed.error_message ?? 'The query could not be parsed.');
    renderCounts(baseCounts);
    ui.resultCount.textContent = '';
    ui.result.replaceChildren();
    return;
  }

  runTranspiler(astJson, await duck.catalogJson());

  const counts: CountRow[] = [...baseCounts];
  for (const c of await duck.cteCounts(astJson)) counts.push({ kind: 'cte', ...c });
  try {
    const t = await duck.query(sql);
    counts.push({ kind: 'result', name: 'result', count: t.numRows });
    ui.resultCount.textContent =
      t.numRows > RESULT_ROW_LIMIT ? `(${t.numRows} rows, first ${RESULT_ROW_LIMIT} shown)` : `(${t.numRows} row${t.numRows === 1 ? '' : 's'})`;
    ui.result.replaceChildren(renderTable(t, RESULT_ROW_LIMIT));
  } catch (e) {
    const error = errorMessage(e);
    counts.push({ kind: 'result', name: 'result', error });
    explain(ui.resultError, 'DuckDB could not run the query', error);
    ui.resultCount.textContent = '';
    ui.result.replaceChildren();
  }
  renderCounts(counts);
}

// One update at a time; edits made while one runs trigger exactly one more.
let running = false;
let dirty = false;
async function refresh(): Promise<void> {
  if (running) {
    dirty = true;
    return;
  }
  running = true;
  try {
    do {
      dirty = false;
      await update();
    } while (dirty);
  } catch (e) {
    ui.status.textContent = `Unexpected error: ${errorMessage(e)}`;
  } finally {
    running = false;
  }
}

let timer: number | undefined;
function scheduleRefresh(): void {
  saveSettings();
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void refresh(), DEBOUNCE_MS);
}

ui.tables.addEventListener('input', scheduleRefresh);
ui.query.addEventListener('input', scheduleRefresh);
ui.fill.addEventListener('change', scheduleRefresh);
ui.regenerate.addEventListener('click', () => {
  seed = (Math.random() * 2 ** 32) >>> 0;
  ui.seed.textContent = String(seed);
  scheduleRefresh();
});

ui.copy.addEventListener('click', async () => {
  const text = ui.m.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API unavailable (e.g. non-secure context): select the text instead.
    const range = document.createRange();
    range.selectNodeContents(ui.m);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (!document.execCommand('copy')) {
      ui.copy.textContent = 'Press Ctrl+C';
      return;
    }
  }
  ui.copy.textContent = 'Copied';
  window.setTimeout(() => (ui.copy.textContent = 'Copy'), 1500);
});

// ---------------------------------------------------------------- start

try {
  duck = await Duck.open();
  ui.status.textContent = 'DuckDB ready';
  ui.status.classList.add('ready');
  await refresh();
} catch (e) {
  ui.status.textContent = `DuckDB failed to load: ${errorMessage(e)}`;
  ui.status.classList.add('failed');
}
