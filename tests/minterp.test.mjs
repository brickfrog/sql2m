import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateM, MDate, MDateTime, MError } from './lib/minterp.mjs';

/** Evaluates a scalar M expression by wrapping it in a one-cell table. */
const val = (expr, sources) => evaluateM(`#table({"v"}, {{${expr}}})`, sources).rows[0][0];

const throwsM = (fn, pattern) => assert.throws(fn, (e) => e instanceof MError && pattern.test(e.message));

const left = {
  columns: ['id', 'k'],
  rows: [[1, 'a'], [2, null], [3, 'x'], [4, 'b']],
};
const right = {
  columns: ['k', 'v'],
  rows: [['b', 10], [null, 20], ['a', 30], ['z', 40], ['a', 50]],
};

test('parses quoted identifiers, comments, escapes and generalized field names', () => {
  const m = `
    // line comment
    let
      /* block
         comment */
      #"say ""hi""" = "a""b#(tab)c#(cr,lf)#(#)(",
      #"Source Rows" = #"order lines",
      r = [#"Order Date" = 1, c.name = 2, plain = 3],
      nested = let x = 5 in let y = x + 1 in y
    in
      Table.AddColumn(
        #"Source Rows",
        "out",
        each Text.From([Order Date] + [c.name]) & #"say ""hi""" & Text.From(r[Order Date] + r[#"c.name"] + nested)
          & Text.From([missing]? ?? 0) & Text.From({7, 8}{1}),
        type text)
  `;
  const out = evaluateM(m, { 'order lines': { columns: ['Order Date', 'c.name'], rows: [[1, 2]] } });
  assert.deepEqual(out.columns, ['Order Date', 'c.name', 'out']);
  assert.equal(out.rows[0][2], '3a"b\tc\r\n#(908');
});

test('let bindings are lazy and order independent', () => {
  assert.equal(val('let b = a + 1, a = 1, unused = Text.Upper(1) in b'), 2);
});

test('function expressions and optional parameters', () => {
  assert.equal(val('let f = (a, optional b as nullable number) as number => a + (b ?? 10) in f(1) + f(1, 2)'), 14);
  assert.equal(val('(each _ * 2)(4)'), 8);
});

test('M equality', () => {
  assert.equal(val('null = null'), true);
  assert.equal(val('null = 1'), false);
  assert.equal(val('null <> 1'), true);
  assert.equal(val('1 = "1"'), false);
  assert.equal(val('1 = 1.0'), true);
  assert.equal(val('#date(2024, 1, 2) = #date(2024, 1, 2)'), true);
  assert.equal(val('{1, null, "a"} = {1, null, "a"}'), true);
  assert.equal(val('[a = 1, b = 2] = [b = 2, a = 1]'), true);
  assert.equal(val('#table({"a"}, {{1}}) = #table({"a"}, {{2}})'), false);
});

test('relational operators: null propagation and type errors', () => {
  assert.equal(val('null < 1'), null);
  assert.equal(val('1 >= null'), null);
  assert.equal(val('"B" < "a"'), true); // ordinal
  assert.equal(val('false < true'), true);
  assert.equal(val('#date(2024, 1, 2) > #date(2023, 12, 31)'), true);
  throwsM(() => val('1 < "2"'), /cannot compare number with text/);
});

test('Kleene and/or/not with short-circuit', () => {
  const cases = [
    ['true and true', true], ['true and false', false], ['true and null', null],
    ['false and null', false], ['null and false', false], ['null and true', null], ['null and null', null],
    ['true or null', true], ['null or true', true], ['null or false', null], ['false or null', null],
    ['false or false', false], ['null or null', null],
    ['not null', null], ['not true', false],
  ];
  for (const [expr, expected] of cases) assert.equal(val(expr), expected, expr);
  // Right operand would raise if evaluated.
  assert.equal(val('false and Text.Upper(1)'), false);
  assert.equal(val('true or Text.Upper(1)'), true);
  throwsM(() => val('null and 1'), /operator and: expected logical, got number/);
  throwsM(() => val('1 or true'), /operator or/);
  throwsM(() => val('not 1'), /operator not/);
});

test('arithmetic, concatenation and coalesce', () => {
  assert.equal(val('null + 1'), null);
  assert.equal(val('2 * null'), null);
  assert.equal(val('1 - 2 * 3'), -5);
  assert.equal(val('7 / 2'), 3.5);
  assert.equal(val('1 / 0'), Infinity);
  assert.equal(val('-1 / 0'), -Infinity);
  assert.ok(Number.isNaN(val('0 / 0')));
  assert.equal(val('"a" & null'), null);
  assert.deepEqual(val('{1} & {2}'), [1, 2]);
  assert.equal(val('([a = 1, b = 2] & [b = 3])[b]'), 3);
  throwsM(() => val('"a" & 1'), /operator &/);
  throwsM(() => val('#date(2024, 1, 1) + 1'), /operator \+/);
  assert.equal(val('null ?? 5'), 5);
  assert.equal(val('3 ?? Text.Upper(1)'), 3);
});

test('if requires a logical condition', () => {
  assert.equal(val('if 1 < 2 then "y" else "n"'), 'y');
  throwsM(() => val('if null then 1 else 2'), /cannot convert null to Logical/);
  throwsM(() => val('if 1 then 1 else 2'), /to Logical/);
});

test('field and item access', () => {
  throwsM(() => val('[a = 1][b]'), /field 'b' not found/);
  assert.equal(val('[a = 1][b]?'), null);
  throwsM(() => val('{1}{1}'), /out of range/);
  assert.equal(val('{1}{1}?'), null);
  assert.deepEqual(val('#table({"a", "b"}, {{1, 2}, {3, 4}})[b]'), [2, 4]);
  throwsM(() => val('#table({"a"}, {{1}})[c]'), /column 'c' not found/);
});

test('#table literal, including zero columns', () => {
  assert.deepEqual(evaluateM('#table({"a", "b"}, {{1, 2}, {3, 4}})'), { columns: ['a', 'b'], rows: [[1, 2], [3, 4]] });
  assert.deepEqual(evaluateM('#table({}, {{}})'), { columns: [], rows: [[]] });
  throwsM(() => evaluateM('#table({"a"}, {{1, 2}})'), /#table/);
});

test('Table.SelectRows drops null predicate results, rejects non-logical', () => {
  const t = { columns: ['x'], rows: [[1], [null], [3]] };
  assert.deepEqual(evaluateM('Table.SelectRows(t, each [x] > 1)', { t }).rows, [[3]]);
  assert.deepEqual(evaluateM('Table.SelectRows(t, each not ([x] > 1))', { t }).rows, [[1]]);
  throwsM(() => evaluateM('Table.SelectRows(t, each [x])', { t }), /Table.SelectRows: predicate returned number/);
});

test('column operations', () => {
  const t = { columns: ['a', 'b', 'c'], rows: [[1, 2, 3]] };
  assert.deepEqual(evaluateM('Table.SelectColumns(t, {"c", "a"})', { t }), { columns: ['c', 'a'], rows: [[3, 1]] });
  assert.deepEqual(evaluateM('Table.RemoveColumns(t, "b")', { t }), { columns: ['a', 'c'], rows: [[1, 3]] });
  assert.deepEqual(evaluateM('Table.ReorderColumns(t, {"c", "a"})', { t }).columns, ['c', 'b', 'a']);
  assert.deepEqual(evaluateM('Table.RenameColumns(t, {{"a", "b"}, {"b", "a"}})', { t }).columns, ['b', 'a', 'c']);
  assert.deepEqual(evaluateM('Table.RenameColumns(t, {"a", "z"})', { t }).columns, ['z', 'b', 'c']);
  throwsM(() => evaluateM('Table.RenameColumns(t, {"a", "b"})', { t }), /Table.RenameColumns: duplicate column 'b'/);
  throwsM(() => evaluateM('Table.SelectColumns(t, {"A"})', { t }), /Table.SelectColumns: column 'A' not found/);
  throwsM(() => evaluateM('Table.RemoveColumns(t, {"q"})', { t }), /Table.RemoveColumns/);
  throwsM(() => evaluateM('Table.AddColumn(t, "a", each 1)', { t }), /Table.AddColumn: column 'a' already exists/);
});

/** Joins left/right with the given kind and expands v, returning [id, v] rows. */
const joinRows = (kind) => evaluateM(`
  let
    j = Table.NestedJoin(left, {"k"}, right, {"k"}, "r", ${kind}),
    e = Table.ExpandTableColumn(j, "r", {"v"})
  in Table.SelectColumns(e, {"id", "v"})`, { left, right }).rows;

test('NestedJoin matches null keys and keeps right order within matches', () => {
  const j = evaluateM('Table.NestedJoin(left, "k", right, "k", "r")', { left, right });
  assert.deepEqual(j.columns, ['id', 'k', 'r']);
  assert.deepEqual(j.rows.map((r) => r[0]), [1, 2, 3, 4]); // default LeftOuter
  assert.deepEqual(joinRows('JoinKind.LeftOuter'), [[1, 30], [1, 50], [2, 20], [3, null], [4, 10]]);
});

test('every JoinKind', () => {
  assert.deepEqual(joinRows('JoinKind.Inner'), [[1, 30], [1, 50], [2, 20], [4, 10]]);
  assert.deepEqual(joinRows('JoinKind.RightOuter'), [[1, 30], [1, 50], [2, 20], [4, 10], [null, 40]]);
  assert.deepEqual(joinRows('JoinKind.FullOuter'), [[1, 30], [1, 50], [2, 20], [3, null], [4, 10], [null, 40]]);
  assert.deepEqual(joinRows('JoinKind.LeftAnti'), [[3, null]]);
  assert.deepEqual(joinRows('JoinKind.RightAnti'), [[null, 40]]);
  // Numeric kinds are accepted too.
  assert.deepEqual(joinRows('0'), joinRows('JoinKind.Inner'));
  // Nested tables: right columns, only the unmatched right row for right-only rows.
  const nested = evaluateM('Table.NestedJoin(left, "k", right, "k", "r", JoinKind.RightAnti)', { left, right });
  assert.deepEqual(nested.rows[0].slice(0, 2), [null, null]);
  assert.deepEqual(evaluateM('x{0}[r]', { x: nested }), { columns: ['k', 'v'], rows: [['z', 40]] });
});

test('NestedJoin on multiple keys uses pairwise M equality', () => {
  const a = { columns: ['p', 'q'], rows: [[1, null], [1, 2]] };
  const b = { columns: ['p2', 'q2', 'w'], rows: [[1, null, 'n'], [1, 2, 'y'], [1, '2', 'text']] };
  const out = evaluateM(`Table.ExpandTableColumn(
    Table.NestedJoin(a, {"p", "q"}, b, {"p2", "q2"}, "b", JoinKind.Inner), "b", {"w"})`, { a, b });
  assert.deepEqual(out.rows, [[1, null, 'n'], [1, 2, 'y']]);
});

test('ExpandTableColumn: empty or null nested yields one null row; renames and errors', () => {
  const t = {
    columns: ['id', 'n', 'z'],
    rows: [[1, null, 'z1']],
  };
  const m = `
    let
      withNested = Table.AddColumn(t, "nested", each
        if [id] = 1 then #table({"a", "b"}, {}) else null),
      reordered = Table.ReorderColumns(withNested, {"nested", "n"})
    in Table.ExpandTableColumn(reordered, "nested", {"b", "a"}, {"B", "A"})`;
  // After reorder: id, nested, z, n  (listed columns fill the slots of n and nested)
  assert.deepEqual(evaluateM(m, { t }), { columns: ['id', 'B', 'A', 'z', 'n'], rows: [[1, null, null, 'z1', null]] });

  const nested = {
    columns: ['id', 'r'],
    rows: [[1, null]],
  };
  assert.deepEqual(evaluateM('Table.ExpandTableColumn(t, "r", {"x"})', { t: nested }).rows, [[1, null]]);
  throwsM(() => evaluateM('Table.ExpandTableColumn(Table.NestedJoin(left, "k", right, "k", "r"), "r", {"k"})', { left, right }),
    /Table.ExpandTableColumn: expanded column 'k' collides/);
  throwsM(() => evaluateM('Table.ExpandTableColumn(Table.NestedJoin(left, "k", right, "k", "r"), "r", {"nope"})', { left, right }),
    /Table.ExpandTableColumn: column 'nope' not found/);
});

test('Table.Group: keys, null keys, empty keys, empty input', () => {
  const t = { columns: ['g', 'amt'], rows: [['b', 1], [null, 2], ['a', 3], ['b', null], [null, 5]] };
  const out = evaluateM(`Table.Group(t, {"g"}, {
      {"total", each List.Sum([amt]), type nullable number},
      {"n", each Table.RowCount(_)}})`, { t });
  assert.deepEqual(out, { columns: ['g', 'total', 'n'], rows: [['b', 1, 2], [null, 7, 2], ['a', 3, 1]] });

  const all = evaluateM('Table.Group(t, {}, {"n", each List.Count([amt])})', { t });
  assert.deepEqual(all, { columns: ['n'], rows: [[5]] });

  const empty = { columns: ['g', 'amt'], rows: [] };
  assert.deepEqual(evaluateM('Table.Group(t, {}, {"n", each Table.RowCount(_)})', { t: empty }), { columns: ['n'], rows: [] });
  assert.deepEqual(evaluateM('Table.Group(t, "g", {})', { t: empty }), { columns: ['g'], rows: [] });
});

test('Table.Sort: nulls first ascending, last descending; multi-criteria; stable', () => {
  const t = { columns: ['id', 'x', 's'], rows: [[1, 2, 'b'], [2, null, 'a'], [3, 1, 'c'], [4, 2, 'a'], [5, null, 'b']] };
  const ids = (criteria) => evaluateM(`Table.Sort(t, ${criteria})`, { t }).rows.map((r) => r[0]);
  assert.deepEqual(ids('"x"'), [2, 5, 3, 1, 4]);
  assert.deepEqual(ids('{"x", Order.Descending}'), [1, 4, 3, 2, 5]);
  assert.deepEqual(ids('{{"x", Order.Descending}, {"s", Order.Ascending}}'), [4, 1, 3, 2, 5]);
  assert.deepEqual(ids('{{each [x] ?? 0, Order.Ascending}, {each Text.Upper([s]), Order.Descending}}'), [5, 2, 3, 1, 4]);
  assert.deepEqual(ids('each [s]'), [2, 4, 1, 5, 3]);
  assert.deepEqual(ids('{"s", "id"}'), [2, 4, 1, 5, 3]);
  const mixed = { columns: ['id', 'x', 's'], rows: [[1, 1, 'a'], [2, 'one', 'b']] };
  throwsM(() => evaluateM('Table.Sort(t, "x")', { t: mixed }), /Table.Sort: cannot order/);
});

test('Table.Distinct and Table.Combine', () => {
  const t = { columns: ['a', 'b'], rows: [[1, null], [1, null], [2, 'x'], [1, 'x'], [2, 'x']] };
  assert.deepEqual(evaluateM('Table.Distinct(t)', { t }).rows, [[1, null], [2, 'x'], [1, 'x']]);
  const out = evaluateM('Table.Combine({#table({"a", "b"}, {{1, 2}}), #table({"c", "a"}, {{3, 4}})})');
  assert.deepEqual(out, { columns: ['a', 'b', 'c'], rows: [[1, 2, null], [4, null, 3]] });
});

test('small table functions', () => {
  const t = { columns: ['a'], rows: [[1], [2], [3]] };
  assert.deepEqual(evaluateM('Table.FirstN(t, 2)', { t }).rows, [[1], [2]]);
  assert.deepEqual(evaluateM('Table.Skip(t, 2)', { t }).rows, [[3]]);
  assert.equal(val('Table.RowCount(t)', { t }), 3);
  assert.equal(val('Table.IsEmpty(Table.FirstN(t, 0))', { t }), true);
  assert.deepEqual(val('Table.ColumnNames(t)', { t }), ['a']);
});

test('list functions ignore nulls', () => {
  assert.equal(val('List.Sum({1, null, 2})'), 3);
  assert.equal(val('List.Sum({null})'), null);
  assert.equal(val('List.Average({1, null, 2})'), 1.5);
  assert.equal(val('List.Average({})'), null);
  assert.equal(val('List.Min({3, null, 1})'), 1);
  assert.equal(val('List.Max({"a", "b", null})'), 'b');
  assert.equal(val('List.Max({})'), null);
  assert.equal(val('List.Count({1, null})'), 2);
  assert.equal(val('List.NonNullCount({1, null})'), 1);
  assert.deepEqual(val('List.Distinct({1, null, 1, "1", null})'), [1, null, '1']);
  assert.deepEqual(val('List.RemoveNulls({null, 1})'), [1]);
  assert.equal(val('List.Contains({1, null}, null)'), true);
  assert.deepEqual(val('List.Transform({1, 2}, each _ * 10)'), [10, 20]);
  throwsM(() => val('List.Sum({"a"})'), /List.Sum: expected a number/);
});

test('text functions', () => {
  assert.equal(val('Text.Upper(null)'), null);
  assert.equal(val('Text.Trim("  a b  ")'), 'a b');
  assert.equal(val('Text.TrimEnd("  a ")'), '  a');
  assert.equal(val('Text.Length("abc")'), 3);
  assert.equal(val('Text.Middle("abcdef", 1, 3)'), 'bcd');
  assert.equal(val('Text.Middle("abc", 1)'), 'bc');
  assert.equal(val('Text.Start("abc", 5)'), 'abc');
  assert.equal(val('Text.End("abc", 2)'), 'bc');
  assert.equal(val('Text.Replace("a-b-c", "-", "+")'), 'a+b+c');
  assert.equal(val('Text.Contains(null, "a")'), null);
  assert.equal(val('Text.StartsWith("abc", "ab")'), true);
  assert.equal(val('Text.EndsWith("abc", "ab")'), false);
  assert.equal(val('Text.From(1.5) & Text.From(2) & Text.From(true)'), '1.52true');
  assert.equal(val('Text.From(#date(2024, 3, 9))'), '2024-03-09');
  assert.equal(val('Text.From(null)'), null);
  assert.equal(val('Text.Combine({"a", null, "b"}, ", ")'), 'a, b');
  throwsM(() => val('Text.Combine({"a", 1})'), /Text.Combine: expected text, got number/);
  throwsM(() => val('Text.Upper(1)'), /Text.Upper: expected text/);
});

test('number, conversion and date functions', () => {
  assert.equal(val('Number.From("  -1.25e1 ")'), -12.5);
  throwsM(() => val('Number.From("abc")'), /Number.From/);
  assert.equal(val('Number.Round(2.5)'), 2);
  assert.equal(val('Number.Round(3.5)'), 4);
  assert.equal(val('Number.Round(-2.5, 0, RoundingMode.AwayFromZero)'), -3);
  assert.equal(val('Number.Round(2.675, 2, RoundingMode.AwayFromZero)'), 2.68);
  assert.equal(val('Number.Round(1.005, 2, RoundingMode.ToEven)'), 1);
  assert.equal(val('Number.Round(1234, -2)'), 1200);
  assert.equal(val('Number.Round(-1.5, 0, RoundingMode.TowardZero)'), -1);
  assert.equal(val('Number.Round(-1.5, 0, RoundingMode.Down)'), -2);
  assert.equal(val('Number.RoundUp(1.21, 1)'), 1.3);
  assert.equal(val('Number.RoundDown(-1.21, 1)'), -1.3);
  assert.equal(val('Number.Abs(-3)'), 3);
  assert.equal(val('Number.Mod(-7, 3)'), -1);
  assert.equal(val('Number.IntegerDivide(-7, 2)'), -3);
  assert.equal(val('Number.Mod(null, 3)'), null);
  throwsM(() => val('Number.IntegerDivide(1, 0)'), /Number.IntegerDivide: division by zero/);
  assert.equal(val('Int64.From("2.5")'), 2);
  assert.equal(val('Int64.From(2.5, null, RoundingMode.AwayFromZero)'), 3);
  assert.equal(val('Logical.From("TRUE")'), true);
  assert.equal(val('Logical.From(0)'), false);
  const d = val('Date.From("2024-02-29")');
  assert.ok(d instanceof MDate);
  assert.equal(String(d), '2024-02-29');
  assert.equal(val('Date.Year(Date.From(#datetime(2023, 4, 5, 6, 7, 8)))'), 2023);
  assert.equal(val('Date.Day(null)'), null);
  assert.equal(String(new MDateTime(2023, 4, 5, 6, 7, 8)), '2023-04-05 06:07:08');
  throwsM(() => val('Date.From("2023-02-29")'), /invalid date/);
});

test('errors name the offending function or identifier', () => {
  throwsM(() => val('Table.Frobnicate(1)'), /unknown identifier 'Table.Frobnicate'/);
  throwsM(() => val('Table.RowCount(1)'), /^Table.RowCount: expected a table, got number$/);
  throwsM(() => val('Text.Upper()'), /Text.Upper: expected 1-2 arguments, got 0/);
  throwsM(() => evaluateM('let a = 1 in a'), /must evaluate to a table/);
  throwsM(() => evaluateM('let a = 1 in'), /M parse error at line 1/);
  throwsM(() => evaluateM('[x] + 1'), /outside of 'each'/);
});

test('realistic multi-step query: join, expand, group, sort', () => {
  const sources = {
    customers: {
      columns: ['customer_id', 'Customer Name', 'region'],
      rows: [[1, 'Ann', 'EU'], [2, 'Bob', 'US'], [3, 'Cy', null], [4, 'Dee', 'EU']],
    },
    'order lines': {
      columns: ['order_id', 'customer_id', 'amount', 'order_date'],
      rows: [
        [10, 1, 5.5, new MDate(2024, 1, 3)],
        [11, 2, 7, new MDate(2024, 1, 4)],
        [12, 1, null, new MDate(2024, 2, 1)],
        [13, 3, 1, new MDate(2023, 12, 31)],
        [14, 9, 100, new MDate(2024, 1, 1)],
      ],
    },
  };
  const m = `
    let
      Source = customers,
      // LEFT JOIN "order lines" ON customer_id, 2024 orders only
      Orders2024 = Table.SelectRows(#"order lines", each Date.Year([order_date]) = 2024),
      Joined = Table.NestedJoin(Source, {"customer_id"}, Orders2024, {"customer_id"}, "o", JoinKind.LeftOuter),
      Expanded = Table.ExpandTableColumn(Joined, "o", {"order_id", "amount"}, {"o.order_id", "o.amount"}),
      Grouped = Table.Group(Expanded, {"region"}, {
        {"customers", each List.Count(List.Distinct([customer_id])), Int64.Type},
        {"orders", each List.NonNullCount([o.order_id]), Int64.Type},
        {"revenue", each List.Sum([o.amount]) ?? 0, type number}
      }),
      Sorted = Table.Sort(Grouped, {{"revenue", Order.Descending}, {"region", Order.Ascending}})
    in
      Sorted`;
  assert.deepEqual(evaluateM(m, sources), {
    columns: ['region', 'customers', 'orders', 'revenue'],
    rows: [['US', 1, 1, 7], ['EU', 2, 2, 5.5], [null, 1, 0, 0]],
  });
});
