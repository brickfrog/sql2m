# sql2m — SQL → Power Query M

A static page that turns a DuckDB SQL `SELECT` into a Power Query M step chain.
It runs entirely in your browser: there is no backend, the page makes no
requests except for its own files, and a Content-Security-Policy
(`connect-src 'self'`) keeps it that way.

```
SQL text → DuckDB-WASM json_serialize_sql() → JSON AST → transpiler (MoonBit → JS) → M text
```

The page also runs your query in DuckDB-WASM against adversarial fake data
(duplicate keys, NULL keys, orphan rows, many-to-many, case/space variants of
the same text). It shows the row count of every table, CTE, and the result,
so join fan-out is visible.

## What it emits

One named step per operation, grouped per CTE, so every step can be inspected
in Power Query's Advanced Editor. A waterfall match stays a waterfall:

| SQL                    | M                                                          |
|------------------------|------------------------------------------------------------|
| WHERE                  | `Table.SelectRows`                                         |
| SELECT cols            | `Table.SelectColumns` (+ `Table.RenameColumns`)            |
| SELECT expr AS x       | `Table.AddColumn`                                          |
| [INNER/LEFT/RIGHT/FULL] JOIN | `Table.NestedJoin` + `Table.ExpandTableColumn`       |
| ANTI JOIN, NOT EXISTS  | `Table.NestedJoin(…, JoinKind.LeftAnti)` + drop the nested column |
| SEMI JOIN, EXISTS, IN (subquery) | `Table.NestedJoin(…, JoinKind.Inner)` + drop the nested column |
| CROSS JOIN             | `Table.AddColumn` of the other table + expand              |
| GROUP BY / HAVING      | `Table.Group` / `Table.SelectRows`                          |
| ORDER BY, LIMIT/OFFSET | `Table.Sort`, `Table.Skip`, `Table.FirstN`                 |
| DISTINCT               | `Table.Distinct`                                           |
| UNION [ALL], EXCEPT, INTERSECT | `Table.Combine`, `Table.Distinct`, anti/semi merges |
| CTE                    | successive `let` steps; the CTE name is the last step      |

### Where SQL and M disagree, and what sql2m does

- **NULL join keys.** Power Query merges match `null` to `null`; SQL never
  matches NULL. sql2m filters null-key rows out of the side that must not
  match (and, for FULL joins, appends them back unmatched). A comment in the
  M says so.
- **Three-valued logic.** In M, `null = null` is `true` and `if null` is an
  error. sql2m emits guards so a `WHERE`/`ON` condition keeps a row exactly
  when SQL would.
- **Sort order of NULL.** DuckDB sorts NULLs last by default; M sorts them
  first. sql2m adds an explicit null criterion to `Table.Sort`.
- **Join conditions that are not plain equalities** (`ON a.k = b.k AND a.x > b.y`)
  are merged on the equality keys and then filtered; for LEFT joins the
  filter runs inside the nested table so unmatched rows are kept.

### Refused, with a message

Window functions and QUALIFY (M has no equivalent that keeps the meaning),
recursive CTEs, ROLLUP/CUBE/GROUPING SETS, `NOT IN (subquery)`, scalar
subqueries, LATERAL/ASOF/POSITIONAL joins, `INTERSECT ALL`/`EXCEPT ALL`,
LIKE patterns with `_` or a middle `%`, FULL joins with non-equality
conditions, and anything that is not a single SELECT. DAX and pandas are out
of scope.

## Develop

Needs Node 22+ and the [MoonBit toolchain](https://www.moonbitlang.com/download).

```sh
npm install
npm run dev      # builds the transpiler, then serves web/ with Vite
npm test         # M interpreter unit tests + differential tests
npm run build    # dist/, the static site
```

- `transpiler/` — the MoonBit transpiler (`transpile(ast_json, catalog_json)`
  returns `{"ok":true,"m":…,"warnings":[…]}` or `{"ok":false,"error":…}`).
- `js/` — the JS export; `tools/build-transpiler.mjs` copies the build to
  `web/src/generated/`.
- `web/` — the page. The DuckDB json extension (needed for
  `json_serialize_sql`) is self-hosted in `web/public/duckdb-extensions/`.
- `tests/lib/minterp.mjs` — a small Power Query M interpreter used as a test
  oracle.
- `tests/diff.test.mjs` — runs each query in DuckDB and its M translation in
  the interpreter over the same adversarial tables and requires equal results
  (as multisets, or in order when the query has an ORDER BY).
- `node tools/m.mjs "<CREATE TABLE …>" "<SELECT …>"` prints the M for a query;
  `node tools/ast.mjs "<SQL>"` prints the DuckDB parse tree.

Tests load the json extension from the same self-hosted files through a
loopback server, so they run without network access.

## Deploy

`.github/workflows/pages.yml` tests, builds, and deploys `dist/` to GitHub
Pages on every push to `main`. In the repository settings, set
Pages → Source to "GitHub Actions".
