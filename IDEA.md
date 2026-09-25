# sql2m — SQL → Power Query M transpiler (browser, client-side)

## Context

I do analysis in DuckDB and pandas. My coworkers work in Power BI and Excel —
Power Query (M) and DAX. I can't install tools on my work laptop, and I can't
discuss the real schema or data outside it. So today I prototype logic at home
and retype it by hand at work.

Goal: a static site that takes SQL in and emits Power Query M out, running
entirely in the browser.

## Why this is tractable

M's step chain and SQL's CTE chain are structurally identical — both are a
sequence of named intermediate tables, each built from the last. That
one-to-one correspondence is what makes SQL → M a syntax-directed translation
rather than a research project.

Direction matters. SQL → M is the easy direction: all the things that make
M → SQL hard (nested tables as first-class values, lazy evaluation, functions
as values) never need to be *represented* going this way. You emit the
canonical pattern and move on.

## Scope

IN:

- SELECT / WHERE / JOIN (all kinds, especially ANTI) / GROUP BY / ORDER BY /
  DISTINCT / CTEs
- The waterfall-match pattern: match, anti-join to remove matches, loosen,
  repeat. This is the real-world case that motivated it.

OUT:

- DAX. Different computational model entirely — CALCULATE modifies filter
  context, measures evaluate per-cell against report slicing, SQL has no
  equivalent. Don't attempt it.
- Window functions. M has no equivalent. Refuse them explicitly with a clear
  message rather than emitting something subtly wrong.
- pandas as input. It's a Python API, not a parseable language. If wanted
  later, route pandas → SQL → M.

## Architecture

Don't write a SQL parser. DuckDB-WASM's `json_serialize_sql()` returns the
parse tree as JSON. So:

    SQL text → DuckDB-WASM parse → JSON AST → transpiler → M text

The transpiler is a pure JSON-AST-to-text function. I'd like to write it in
MoonBit (compiles to WASM, and exhaustive matching on AST node types means an
unhandled node is a compile error, not silently-wrong output). Alternative is
TypeScript if MoonBit+duckdb-wasm glue proves annoying. Either is acceptable.

Bonus worth building: DuckDB-WASM can also *execute*, so the page can run the
query against generated fake data and show the result table. Row counts make
join fan-out visible rather than theoretical. Deliberately-adversarial
fixtures — duplicate keys, orphan rows, many-to-many — are more useful than
realistic data.

## Mapping

| SQL              | M                                          |
|------------------|--------------------------------------------|
| WHERE            | Table.SelectRows                           |
| SELECT cols      | Table.SelectColumns                        |
| SELECT expr AS x | Table.AddColumn                            |
| JOIN             | Table.NestedJoin + Table.ExpandTableColumn |
| ANTI JOIN        | Table.NestedJoin (LeftAnti) + expand       |
| GROUP BY         | Table.Group                                |
| ORDER BY         | Table.Sort                                 |
| DISTINCT         | Table.Distinct                             |
| CTE              | successive let steps                       |

Note SQL sets are unordered, M tables are ordered. That asymmetry favours this
direction (M is stricter), but a round-trip won't be identity.

## Output design constraint

Optimise the emitted M for readability in Power Query's Advanced Editor, not
for brevity. Emit a step chain with meaningful step names. Do NOT collapse
ten-step waterfall into one clever windowed expression — the person
maintaining it works in a UI built around visible sequential steps, and nee
to click through and inspect each one.

## Deployment

Static site, GitHub Pages. Fully client-side, no backend, nothing transmitt
— the tool must never become a data egress path.

Repo: sql2m
Title: "SQL → Power Query M"
Subtitle should state it runs entirely in your browser.

## First milestone

Joins only. SQL in, M out, correct about cardinality. That's the part I can
reason about at work and can't ask anyone about. Widen function coverage on
if it proves useful.
