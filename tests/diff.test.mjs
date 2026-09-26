// Differential tests: every query runs in DuckDB-WASM and, transpiled to M, in
// the M interpreter over the same adversarial tables (duplicate keys, NULL keys,
// orphans, many-to-many, case/space variants). The results must be equal.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { catalog, openDuck, serialize } from '../tools/duck.mjs';
import { transpile } from '../web/src/generated/sql2m.js';
import { evaluateM, MDate, MDateTime } from './lib/minterp.mjs';

const FIXTURES = `
CREATE TABLE customers (id INTEGER, name VARCHAR, region VARCHAR, signup DATE);
INSERT INTO customers VALUES
  (1, 'Ann', 'north', '2024-01-05'),
  (2, 'Bob', 'south', '2024-02-10'),
  (2, 'Bob again', 'south', '2024-02-11'),      -- duplicate key
  (3, 'Cy', NULL, NULL),
  (NULL, 'Nobody', 'north', '2024-03-01'),      -- NULL key
  (5, ' ann ', 'North', '2024-01-05'),           -- case/space variant
  (6, 'Eve', 'east', '2024-04-01');              -- no orders
CREATE TABLE orders (order_id INTEGER, customer_id INTEGER, amount DOUBLE, status VARCHAR, ordered_on DATE);
INSERT INTO orders VALUES
  (10, 1, 100, 'paid', '2024-01-10'),
  (11, 1, 50.5, 'open', '2024-01-11'),
  (12, 2, 20, 'paid', '2024-02-12'),
  (13, 2, NULL, 'paid', NULL),
  (14, NULL, 70, 'open', '2024-02-01'),          -- NULL key
  (15, 99, 5, 'void', '2024-03-03'),             -- orphan
  (16, 3, 0, NULL, '2024-03-04'),
  (17, 5, 100, 'paid', '2024-01-10'),
  (17, 5, 100, 'paid', '2024-01-10');            -- exact duplicate row
CREATE TABLE invoices (invoice_id INTEGER, customer_ref VARCHAR, amount DOUBLE, invoice_date DATE);
INSERT INTO invoices VALUES
  (100, 'ACME', 250, '2024-01-01'),
  (101, 'acme ', 99, '2024-01-02'),
  (102, 'Globex', 40, '2024-01-03'),
  (103, 'Globex', 40, '2024-01-04'),             -- duplicate match candidates
  (104, NULL, 10, '2024-01-05'),
  (105, 'Initech', 75, '2024-01-06');
CREATE TABLE payments (payment_id INTEGER, customer_ref VARCHAR, amount DOUBLE, paid_on DATE);
INSERT INTO payments VALUES
  (1, 'ACME', 250, '2024-02-01'),
  (2, 'ACME', 99, '2024-02-02'),
  (3, 'Globex', 40, '2024-02-03'),
  (4, NULL, 10, '2024-02-04'),
  (5, 'Umbrella', 5, '2024-02-05'),
  (6, ' initech', 75, '2024-02-06'),
  (7, 'globex', 1, '2024-02-07');
`;

let conn;
let sources;
let cat;

function toM(v, type) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (/^Date/.test(type)) {
    const d = new Date(Number(v));
    return new MDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  if (/^Timestamp/.test(type)) {
    const d = new Date(Number(v));
    return new MDateTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  }
  if (typeof v === 'object' && typeof v.valueOf === 'function') return Number(v.valueOf());
  return v;
}

function duckTable(sql) {
  const t = conn.query(sql);
  const fields = t.schema.fields;
  return {
    columns: fields.map((f) => f.name),
    rows: t.toArray().map((r) => fields.map((f) => toM(r[f.name], String(f.type)))),
  };
}

// Canonical text for one cell so both engines compare equal.
function cell(v) {
  if (v === null) return 'null';
  if (v instanceof MDate || v instanceof MDateTime) return `d:${v.toString()}`;
  if (typeof v === 'number') return `n:${Math.abs(v) < 1e-9 ? 0 : Number(v.toPrecision(12))}`;
  return `${typeof v}:${v}`;
}
const rowKey = (r) => JSON.stringify(r.map(cell));

before(async () => {
  conn = await openDuck();
  conn.query(FIXTURES);
  cat = catalog(conn);
  sources = {};
  for (const t of cat.tables) sources[t.name] = duckTable(`SELECT * FROM "${t.name}"`);
});

function toMQuery(sql) {
  return JSON.parse(transpile(serialize(conn, sql), JSON.stringify(cat)));
}

function same(sql, { ordered = false, columns = true } = {}) {
  const res = toMQuery(sql);
  assert.ok(res.ok, `refused: ${res.error}`);
  const want = duckTable(sql);
  let got;
  try {
    got = evaluateM(res.m, sources);
  } catch (e) {
    assert.fail(`M evaluation failed: ${e.message}\n${res.m}`);
  }
  if (columns) assert.deepEqual(got.columns, want.columns, res.m);
  const g = got.rows.map(rowKey);
  const w = want.rows.map(rowKey);
  if (!ordered) {
    g.sort();
    w.sort();
  }
  assert.deepEqual(g, w, `row mismatch (${got.rows.length} M rows vs ${want.rows.length} SQL rows)\n${res.m}`);
  return res;
}

function refused(sql, pattern) {
  const res = toMQuery(sql);
  assert.equal(res.ok, false, `expected a refusal, got:\n${res.m}`);
  assert.match(res.error, pattern);
}

const cases = {
  // --- joins: cardinality with duplicate, NULL and orphan keys
  'inner join fans out on duplicate keys': 'SELECT c.name, o.order_id FROM customers c JOIN orders o ON c.id = o.customer_id',
  'left join keeps orphans and null keys': 'SELECT c.id, c.name, o.order_id, o.amount FROM customers c LEFT JOIN orders o ON c.id = o.customer_id',
  'right join': 'SELECT c.name, o.order_id FROM customers c RIGHT JOIN orders o ON c.id = o.customer_id',
  'full join': 'SELECT c.id, c.name, o.order_id FROM customers c FULL JOIN orders o ON c.id = o.customer_id',
  'semi join': 'SELECT * FROM customers c SEMI JOIN orders o ON c.id = o.customer_id',
  'anti join keeps null-key rows': 'SELECT * FROM customers c ANTI JOIN orders o ON c.id = o.customer_id',
  'anti join from the orders side': 'SELECT order_id FROM orders o ANTI JOIN customers c ON o.customer_id = c.id',
  'cross join': 'SELECT c.id, o.order_id FROM customers c CROSS JOIN orders o WHERE o.amount > 60',
  'join using': 'SELECT customer_ref, i.invoice_id, p.payment_id FROM invoices i JOIN payments p USING (customer_ref)',
  'multi-key many-to-many join': 'SELECT i.invoice_id, p.payment_id FROM invoices i JOIN payments p ON i.customer_ref = p.customer_ref AND i.amount = p.amount',
  'join with residual condition': 'SELECT c.name, o.order_id FROM customers c JOIN orders o ON c.id = o.customer_id AND o.amount > c.id * 10',
  'left join with right-only ON filter': "SELECT c.id, o.order_id FROM customers c LEFT JOIN orders o ON c.id = o.customer_id AND o.status = 'paid'",
  'left join with left-only ON filter': "SELECT c.id, c.name, o.order_id FROM customers c LEFT JOIN orders o ON c.id = o.customer_id AND c.region = 'north'",
  'left join with residual ON': 'SELECT c.id, o.order_id FROM customers c LEFT JOIN orders o ON c.id = o.customer_id AND o.amount > c.id * 30',
  'join on expression keys': 'SELECT i.invoice_id, p.payment_id FROM invoices i JOIN payments p ON lower(trim(i.customer_ref)) = lower(trim(p.customer_ref))',
  'self join': 'SELECT a.name, b.name AS other FROM customers a JOIN customers b ON a.id = b.id AND a.name <> b.name',
  'three-way join': 'SELECT c.name, o.order_id, p.payment_id FROM customers c JOIN orders o ON c.id = o.customer_id LEFT JOIN payments p ON o.amount = p.amount',
  'join a subquery': "SELECT c.name, t.total FROM customers c JOIN (SELECT customer_id, sum(amount) AS total FROM orders GROUP BY customer_id) t ON c.id = t.customer_id",
  'anti join on inequality': 'SELECT order_id FROM orders o ANTI JOIN orders b ON o.amount < b.amount',
  'left anti via IS NULL': 'SELECT c.id, c.name FROM customers c LEFT JOIN orders o ON c.id = o.customer_id WHERE o.order_id IS NULL',

  // --- WHERE with three-valued logic
  'where not equal drops nulls': "SELECT order_id FROM orders WHERE status <> 'paid'",
  'where not (a = b)': "SELECT order_id FROM orders WHERE NOT (status = 'paid' OR amount > 60)",
  'where or with is null': 'SELECT order_id FROM orders WHERE amount > 60 OR status IS NULL',
  'where in list': 'SELECT order_id FROM orders WHERE customer_id IN (1, 2, NULL)',
  'where not in list': 'SELECT order_id FROM orders WHERE customer_id NOT IN (1, 2)',
  'where between and like': "SELECT name FROM customers WHERE id BETWEEN 2 AND 5 AND name LIKE 'B%'",
  'where coalesce and case': "SELECT order_id, CASE WHEN amount >= 100 THEN 'big' WHEN amount IS NULL THEN 'unknown' ELSE 'small' END AS size FROM orders WHERE coalesce(status, 'none') <> 'void'",
  'where on dates': "SELECT order_id FROM orders WHERE ordered_on >= DATE '2024-02-01'",
  'date arithmetic': "SELECT order_id, ordered_on + 7 AS due, ordered_on - DATE '2024-01-01' AS age FROM orders",
  'where exists correlated': 'SELECT c.name FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)',
  'where not exists correlated': 'SELECT c.name FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)',
  'where in subquery': "SELECT name FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE status = 'paid')",

  // --- SELECT expressions
  'computed columns': "SELECT order_id, amount * 2 AS double_amount, upper(status) AS s, amount / 4 AS q, status || '!' AS bang FROM orders",
  'select star except': 'SELECT * EXCLUDE (signup) FROM customers',
  'repeated column': 'SELECT id, id AS id2, name FROM customers',

  // --- GROUP BY / HAVING
  'group by with null key': 'SELECT customer_id, count(*) AS n, count(amount) AS n_amount, sum(amount) AS total, min(amount) AS lo, max(amount) AS hi FROM orders GROUP BY customer_id',
  'group by having': 'SELECT customer_id, sum(amount) AS total FROM orders GROUP BY customer_id HAVING count(*) > 1',
  'group by expression': 'SELECT lower(trim(customer_ref)) AS ref, count(*) AS n FROM payments GROUP BY lower(trim(customer_ref))',
  'count distinct and avg': 'SELECT status, count(DISTINCT customer_id) AS customers, avg(amount) AS mean FROM orders GROUP BY status',
  'global aggregate': 'SELECT count(*) AS n, sum(amount) AS total FROM orders',
  'global aggregate over empty input': "SELECT count(*) AS n, sum(amount) AS total FROM orders WHERE status = 'nope'",
  'group after join': 'SELECT c.region, count(o.order_id) AS orders FROM customers c LEFT JOIN orders o ON c.id = o.customer_id GROUP BY c.region',
  'aggregate filter': "SELECT customer_id, count(*) FILTER (WHERE status = 'paid') AS paid FROM orders GROUP BY customer_id",

  // --- DISTINCT, set ops
  distinct: 'SELECT DISTINCT customer_id, status FROM orders',
  union: 'SELECT customer_ref FROM invoices UNION SELECT customer_ref FROM payments',
  'union all': 'SELECT customer_ref FROM invoices UNION ALL SELECT customer_ref FROM payments',
  except: 'SELECT customer_ref FROM invoices EXCEPT SELECT customer_ref FROM payments',
  intersect: 'SELECT customer_ref FROM invoices INTERSECT SELECT customer_ref FROM payments',

  // --- CTEs and the waterfall
  'waterfall match': `WITH exact AS (
      SELECT p.payment_id, i.invoice_id, 'exact' AS tier
      FROM payments p JOIN invoices i ON p.customer_ref = i.customer_ref AND p.amount = i.amount
    ),
    rest1 AS (SELECT * FROM payments p ANTI JOIN exact e ON p.payment_id = e.payment_id),
    loose AS (
      SELECT r.payment_id, i.invoice_id, 'ref, case-insensitive' AS tier
      FROM rest1 r JOIN invoices i ON lower(trim(r.customer_ref)) = lower(trim(i.customer_ref))
    ),
    rest2 AS (SELECT * FROM rest1 r ANTI JOIN loose l ON r.payment_id = l.payment_id)
    SELECT * FROM exact
    UNION ALL SELECT * FROM loose
    UNION ALL SELECT payment_id, NULL, 'unmatched' FROM rest2`,
};

for (const [name, sql] of Object.entries(cases)) {
  test(name, () => same(sql));
}

// --- ORDER BY: DuckDB puts NULLs last by default; M sorts them first.
const orderedCases = {
  'order by with nulls last': 'SELECT order_id, amount FROM orders ORDER BY amount, order_id',
  'order by desc': 'SELECT order_id, amount FROM orders ORDER BY amount DESC, order_id DESC',
  'order by nulls first': 'SELECT order_id, amount FROM orders ORDER BY amount NULLS FIRST, order_id',
  'order by limit offset': 'SELECT order_id FROM orders ORDER BY order_id LIMIT 3 OFFSET 2',
  'order by alias and position': 'SELECT order_id, amount * 2 AS twice FROM orders ORDER BY twice DESC, 1',
};
for (const [name, sql] of Object.entries(orderedCases)) {
  test(name, () => same(sql, { ordered: true }));
}

// --- Window functions and QUALIFY. `orders` has a NULL customer, a NULL
// status, a NULL amount, ties on amount, and two identical rows (order 17).
const windowCases = {
  'row_number per partition': 'SELECT order_id, customer_id, row_number() OVER (PARTITION BY customer_id ORDER BY amount DESC, order_id) AS rn FROM orders',
  'qualify latest per key': 'SELECT * FROM orders QUALIFY row_number() OVER (PARTITION BY customer_id ORDER BY ordered_on DESC, order_id) = 1',
  'qualify on a select alias': 'SELECT order_id, status, rank() OVER (PARTITION BY status ORDER BY amount DESC) AS r FROM orders QUALIFY r <= 2',
  'rank family with ties and nulls': 'SELECT order_id, status, rank() OVER (PARTITION BY status ORDER BY amount) AS r, dense_rank() OVER (PARTITION BY status ORDER BY amount) AS d, percent_rank() OVER (PARTITION BY status ORDER BY amount) AS pr, cume_dist() OVER (PARTITION BY status ORDER BY amount) AS cd FROM orders',
  'rank without partition, nulls first': 'SELECT order_id, dense_rank() OVER (ORDER BY amount DESC NULLS FIRST) AS d FROM orders',
  ntile: 'SELECT order_id, ntile(3) OVER (ORDER BY order_id) AS t3, ntile(4) OVER (PARTITION BY status ORDER BY order_id) AS t4, ntile(20) OVER (ORDER BY order_id) AS t20 FROM orders',
  'lag and lead': 'SELECT order_id, lag(amount) OVER (PARTITION BY customer_id ORDER BY order_id) AS prev, lead(amount, 2, -1) OVER (ORDER BY order_id) AS next2 FROM orders',
  'partition aggregates': 'SELECT order_id, sum(amount) OVER (PARTITION BY customer_id) AS total, count(*) OVER (PARTITION BY status) AS n, count(amount) OVER (PARTITION BY status) AS n_amount, avg(amount) OVER () AS mean, min(ordered_on) OVER (PARTITION BY customer_id) AS first_day, max(amount) OVER () AS hi FROM orders',
  'running total with RANGE ties': 'SELECT order_id, sum(amount) OVER (PARTITION BY customer_id ORDER BY order_id) AS running, count(*) OVER (ORDER BY order_id) AS so_far FROM orders',
  'running total with ROWS': 'SELECT order_id, sum(amount) OVER (ORDER BY order_id, customer_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running FROM orders',
  'moving frames': 'SELECT order_id, avg(amount) OVER (ORDER BY order_id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS moving, count(amount) OVER (ORDER BY order_id ROWS BETWEEN 2 PRECEDING AND 1 PRECEDING) AS before2, sum(amount) OVER (ORDER BY order_id ROWS BETWEEN 1 FOLLOWING AND 2 FOLLOWING) AS after2 FROM orders',
  'first, last and nth value': 'SELECT order_id, first_value(order_id) OVER (PARTITION BY customer_id ORDER BY order_id) AS fv, last_value(order_id) OVER (PARTITION BY customer_id ORDER BY order_id) AS lv_peer, last_value(amount) OVER (PARTITION BY customer_id ORDER BY order_id ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS lv, nth_value(order_id, 2) OVER (PARTITION BY customer_id ORDER BY order_id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS second FROM orders',
  'window over grouped rows': 'SELECT customer_id, sum(amount) AS total, rank() OVER (ORDER BY sum(amount) DESC) AS r FROM orders GROUP BY customer_id',
  'window partitioned by an expression': 'SELECT payment_id, row_number() OVER (PARTITION BY lower(trim(customer_ref)) ORDER BY payment_id) AS rn FROM payments',
  'window inside an expression': 'SELECT order_id, amount - avg(amount) OVER (PARTITION BY status) AS diff FROM orders',
  'dedupe then waterfall': `WITH latest AS (
      SELECT * FROM payments
      QUALIFY row_number() OVER (PARTITION BY lower(trim(customer_ref)) ORDER BY paid_on DESC, payment_id) = 1
    )
    SELECT l.payment_id, l.customer_ref FROM latest l ANTI JOIN invoices i ON l.customer_ref = i.customer_ref`,
};
for (const [name, sql] of Object.entries(windowCases)) {
  test(name, () => same(sql));
}
test('window in ORDER BY', () => same('SELECT order_id FROM orders ORDER BY rank() OVER (ORDER BY amount DESC), order_id', { ordered: true }));

test('warns only where ORDER BY ties change the answer', () => {
  const tie = toMQuery('SELECT order_id, row_number() OVER (PARTITION BY status ORDER BY amount) AS rn FROM orders');
  assert.ok(tie.warnings.some((w) => /tie/.test(w)), JSON.stringify(tie.warnings));
  const rank = toMQuery('SELECT order_id, rank() OVER (PARTITION BY status ORDER BY amount) AS r FROM orders');
  assert.deepEqual(rank.warnings, []);
});

test('join steps are readable and never collapsed', () => {
  const res = same(cases['waterfall match']);
  assert.match(res.m, /#"rest1: Removed rows matching e" = Table\.NestedJoin\(payments, \{"payment_id"\}, #"rest1: Filtered e", \{"payment_id"\}, "e", JoinKind\.LeftAnti\)/);
  assert.match(res.m, /\n {4}rest2 = /);
});

test('refuses what it cannot translate faithfully', () => {
  refused('SELECT order_id, sum(amount) OVER (ORDER BY ordered_on RANGE BETWEEN INTERVAL 7 DAYS PRECEDING AND CURRENT ROW) FROM orders', /RANGE/);
  refused('SELECT order_id, last_value(amount IGNORE NULLS) OVER (ORDER BY order_id) FROM orders', /IGNORE NULLS/);
  refused('SELECT order_id FROM orders WHERE row_number() OVER (ORDER BY order_id) = 1', /only allowed in SELECT, QUALIFY and ORDER BY/);
  refused('WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT * FROM r', /RECURSIVE/);
  refused('SELECT name FROM customers WHERE id NOT IN (SELECT customer_id FROM orders)', /NOT IN/);
  refused("SELECT name FROM customers WHERE name LIKE 'B_b'", /LIKE/);
  refused('SELECT 1; SELECT 2', /one statement|single statement|statements/);
  refused('SELECT * FROM nowhere', /nowhere/);
  refused("SELECT c.id, o.order_id FROM customers c FULL JOIN orders o ON c.id = o.customer_id AND o.status = 'paid'", /FULL JOIN/);
});
