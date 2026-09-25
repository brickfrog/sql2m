// Typed view of DuckDB's `json_serialize_sql` parse tree.
//
// Decoding is where unsupported SQL is refused: every node type sql2m does
// not translate faithfully raises `Refuse` with an explanation, so nothing
// downstream ever sees a construct it would have to guess about.

///|
priv enum CmpOp {
  Eq
  Ne
  Lt
  Le
  Gt
  Ge
  IsDistinct
  NotDistinct
} derive(Eq, Debug)

///|
priv enum Lit {
  LNull
  LBool(Bool)
  LNum(String)
  LText(String)
  LDate(Int, Int, Int)
  LDateTime(Int, Int, Int, Int, Int, Int)
} derive(Eq, Debug)

///|
priv enum Expr {
  Col(Array[String])
  Const(Lit)
  Star(String, Array[String])
  /// name (lowercase), args, DISTINCT, FILTER (WHERE ...)
  Func(String, Array[Expr], Bool, Expr?)
  Cmp(CmpOp, Expr, Expr)
  And(Array[Expr])
  Or(Array[Expr])
  Not(Expr)
  /// negated = IS NOT NULL
  IsNull(Expr, Bool)
  /// negated = NOT IN
  InList(Expr, Array[Expr], Bool)
  Between(Expr, Expr, Expr)
  Case(Array[(Expr, Expr)], Expr)
  /// target type id (upper case), decimal scale (-1 when not a decimal)
  Cast(Expr, String, Int)
  Coalesce(Array[Expr])
  /// x [NOT] IN (subquery)
  InSub(Expr, Query, Bool)
  Exists(Query)
} derive(Eq, Debug)

///|
priv struct Cte {
  name : String
  aliases : Array[String]
  query : Query
} derive(Eq, Debug)

///|
priv struct OrderItem {
  expr : Expr
  desc : Bool
  nulls_first : Bool
} derive(Eq, Debug)

///|
priv struct Mods {
  distinct : Bool
  order : Array[OrderItem]
  limit : Expr?
  offset : Expr?
} derive(Eq, Debug)

///|
priv enum JoinKind {
  Inner
  Left
  Right
  Full
  Semi
  Anti
  Cross
} derive(Eq, Debug)

///|
priv enum TableRef {
  /// table name, alias
  Base(String, String)
  /// subquery, alias, column aliases
  Sub(Query, String, Array[String])
  /// kind, left, right, ON condition, USING columns, NATURAL
  Join(JoinKind, TableRef, TableRef, Expr?, Array[String], Bool)
  NoFrom
} derive(Eq, Debug)

///|
priv struct SelectItem {
  expr : Expr
  as_name : String
} derive(Eq, Debug)

///|
priv struct SelectNode {
  ctes : Array[Cte]
  items : Array[SelectItem]
  from : TableRef
  where_ : Expr?
  group : Array[Expr]
  group_all : Bool
  having : Expr?
  mods : Mods
} derive(Eq, Debug)

///|
priv enum SetKind {
  Union
  UnionByName
  Except
  Intersect
} derive(Eq, Debug)

///|
priv enum Query {
  Select(SelectNode)
  /// kind, ALL, left, right, CTEs, modifiers
  SetOp(SetKind, Bool, Query, Query, Array[Cte], Mods)
} derive(Eq, Debug)

// ---------------------------------------------------------------------------
// JSON access helpers

///|
fn jget(j : Json, key : String) -> Json {
  match j {
    Object(m) =>
      match m.get(key) {
        Some(v) => v
        None => Json::null()
      }
    _ => Json::null()
  }
}

///|
fn jstr(j : Json, key : String) -> String {
  match jget(j, key) {
    String(s) => s
    _ => ""
  }
}

///|
fn jarr(j : Json, key : String) -> Array[Json] {
  match jget(j, key) {
    Array(a) => a
    _ => []
  }
}

///|
fn jbool(j : Json, key : String) -> Bool {
  jget(j, key) is True
}

///|
fn jnull(j : Json) -> Bool {
  j is Null
}

///|
fn strings(a : Array[Json]) -> Array[String] {
  let out = []
  for v in a {
    if v is String(s) {
      out.push(s)
    }
  }
  out
}

// ---------------------------------------------------------------------------
// Refusal messages shared by several decoders

///|
let window_refusal : String = "Window functions (... OVER (...)) have no Power Query M equivalent, so sql2m refuses them rather than emit something subtly wrong. Rewrite with GROUP BY plus a join back to the detail rows, or compute the ranking in the source system."

// ---------------------------------------------------------------------------
// Statements

///|
fn decode_document(doc : Json) -> Query raise Refuse {
  if jbool(doc, "error") {
    let msg = jstr(doc, "error_message")
    if msg.contains("Only SELECT") {
      raise Refuse(
        "Only a SELECT query can be translated. Put CREATE TABLE statements in the Tables pane.",
      )
    }
    raise Refuse("DuckDB could not parse the query: " + msg)
  }
  let stmts = jarr(doc, "statements")
  if stmts.length() == 0 {
    raise Refuse("The query is empty.")
  }
  if stmts.length() > 1 {
    raise Refuse(
      "Found \{stmts.length()} statements; translate one SELECT at a time.",
    )
  }
  decode_query(jget(stmts[0], "node"))
}

///|
fn decode_query(node : Json) -> Query raise Refuse {
  match jstr(node, "type") {
    "SELECT_NODE" => Select(decode_select(node))
    "SET_OPERATION_NODE" => {
      let kind : SetKind = match jstr(node, "setop_type") {
        "UNION" => Union
        "UNION_BY_NAME" => UnionByName
        "EXCEPT" => Except
        "INTERSECT" => Intersect
        other => raise Refuse("Set operation \{other} is not supported.")
      }
      let all = jbool(node, "setop_all")
      if all && (kind == Except || kind == Intersect) {
        raise Refuse(
          "EXCEPT ALL / INTERSECT ALL (multiset semantics) are not supported; use EXCEPT / INTERSECT or an anti/semi join.",
        )
      }
      SetOp(
        kind,
        all,
        decode_query(jget(node, "left")),
        decode_query(jget(node, "right")),
        decode_ctes(node),
        decode_mods(node),
      )
    }
    "RECURSIVE_CTE_NODE" =>
      raise Refuse(
        "WITH RECURSIVE has no step-chain equivalent in Power Query; it is not supported.",
      )
    "CTE_NODE" => raise Refuse("Unsupported CTE form.")
    other => raise Refuse("Unsupported query node \{other}.")
  }
}

///|
fn decode_ctes(node : Json) -> Array[Cte] raise Refuse {
  let out = []
  for entry in jarr(jget(node, "cte_map"), "map") {
    let value = jget(entry, "value")
    let query_node = jget(jget(value, "query"), "node")
    out.push({
      name: jstr(entry, "key"),
      aliases: strings(jarr(value, "aliases")),
      query: decode_query(query_node),
    })
  }
  out
}

///|
fn decode_mods(node : Json) -> Mods raise Refuse {
  let mut distinct = false
  let order = []
  let mut limit : Expr? = None
  let mut offset : Expr? = None
  for m in jarr(node, "modifiers") {
    match jstr(m, "type") {
      "DISTINCT_MODIFIER" => {
        if jarr(m, "distinct_on_targets").length() > 0 {
          raise Refuse(
            "DISTINCT ON keeps one arbitrary row per key, which is a window operation; it is not supported. Use GROUP BY with explicit aggregates.",
          )
        }
        distinct = true
      }
      "ORDER_MODIFIER" =>
        for o in jarr(m, "orders") {
          let desc = jstr(o, "type") == "DESCENDING"
          // DuckDB's default is NULLS LAST for both directions.
          let nulls_first = jstr(o, "null_order") == "NULLS FIRST"
          order.push({
            expr: decode_expr(jget(o, "expression")),
            desc,
            nulls_first,
          })
        }
      "LIMIT_MODIFIER" => {
        let l = jget(m, "limit")
        if !jnull(l) {
          limit = Some(decode_expr(l))
        }
        let off = jget(m, "offset")
        if !jnull(off) {
          offset = Some(decode_expr(off))
        }
      }
      "LIMIT_PERCENT_MODIFIER" =>
        raise Refuse("LIMIT with a percentage is not supported.")
      other => raise Refuse("Unsupported query modifier \{other}.")
    }
  }
  { distinct, order, limit, offset, }
}

///|
fn decode_select(node : Json) -> SelectNode raise Refuse {
  if !jnull(jget(node, "qualify")) {
    raise Refuse(window_refusal)
  }
  if !jnull(jget(node, "sample")) {
    raise Refuse("USING SAMPLE is not supported.")
  }
  if jarr(node, "group_sets").length() > 1 {
    raise Refuse(
      "GROUPING SETS / ROLLUP / CUBE are not supported; write one GROUP BY per grouping and UNION ALL them.",
    )
  }
  let items = []
  for item in jarr(node, "select_list") {
    items.push({ expr: decode_expr(item), as_name: jstr(item, "alias"), })
  }
  let where_j = jget(node, "where_clause")
  let having_j = jget(node, "having")
  let group = []
  for g in jarr(node, "group_expressions") {
    group.push(decode_expr(g))
  }
  {
    ctes: decode_ctes(node),
    items,
    from: decode_table(jget(node, "from_table")),
    where_: if jnull(where_j) {
      None
    } else {
      Some(decode_expr(where_j))
    },
    group,
    group_all: jstr(node, "aggregate_handling") == "FORCE_AGGREGATES",
    having: if jnull(having_j) {
      None
    } else {
      Some(decode_expr(having_j))
    },
    mods: decode_mods(node),
  }
}

///|
fn decode_table(t : Json) -> TableRef raise Refuse {
  if jnull(t) {
    return NoFrom
  }
  if !jnull(jget(t, "sample")) {
    raise Refuse("TABLESAMPLE is not supported.")
  }
  match jstr(t, "type") {
    "EMPTY" => NoFrom
    "BASE_TABLE" => Base(jstr(t, "table_name"), jstr(t, "alias"))
    "SUBQUERY" =>
      Sub(
        decode_query(jget(jget(t, "subquery"), "node")),
        jstr(t, "alias"),
        strings(jarr(t, "column_name_alias")),
      )
    "JOIN" => {
      let ref_type = jstr(t, "ref_type")
      let natural = ref_type == "NATURAL"
      match ref_type {
        "POSITIONAL" =>
          raise Refuse(
            "POSITIONAL JOIN depends on physical row order; it is not supported.",
          )
        "ASOF" =>
          raise Refuse(
            "ASOF JOIN picks the single nearest match per row (a window operation); it is not supported. Express the tolerance as a range condition and pick the match explicitly.",
          )
        "DEPENDENT" | "LATERAL" =>
          raise Refuse("LATERAL joins are not supported.")
        _ => ()
      }
      let kind : JoinKind = if ref_type == "CROSS" {
        Cross
      } else {
        match jstr(t, "join_type") {
          "INNER" => Inner
          "LEFT" => Left
          "RIGHT" => Right
          "OUTER" | "FULL" => Full
          "SEMI" => Semi
          "ANTI" => Anti
          other => raise Refuse("Unsupported join type \{other}.")
        }
      }
      let cond = jget(t, "condition")
      Join(
        kind,
        decode_table(jget(t, "left")),
        decode_table(jget(t, "right")),
        if jnull(cond) {
          None
        } else {
          Some(decode_expr(cond))
        },
        strings(jarr(t, "using_columns")),
        natural,
      )
    }
    "TABLE_FUNCTION" =>
      raise Refuse(
        "Table functions (read_csv, range, ...) are not Power Query sources. Declare the data as a table in the Tables pane and query it by name.",
      )
    other => raise Refuse("Unsupported FROM item \{other}.")
  }
}

// ---------------------------------------------------------------------------
// Expressions

///|
fn decode_exprs(a : Array[Json]) -> Array[Expr] raise Refuse {
  let out = []
  for e in a {
    out.push(decode_expr(e))
  }
  out
}

///|
fn decode_expr(e : Json) -> Expr raise Refuse {
  let cls = jstr(e, "class")
  let ty = jstr(e, "type")
  match cls {
    "COLUMN_REF" => Col(strings(jarr(e, "column_names")))
    "CONSTANT" => Const(decode_value(jget(e, "value")))
    "STAR" => {
      if jbool(e, "columns") {
        raise Refuse("COLUMNS(...) expressions are not supported.")
      }
      if jarr(e, "replace_list").length() > 0 ||
        jarr(e, "rename_list").length() > 0 {
        raise Refuse("* REPLACE / * RENAME are not supported.")
      }
      Star(jstr(e, "relation_name"), strings(jarr(e, "exclude_list")))
    }
    "FUNCTION" => {
      let name = jstr(e, "function_name").to_lower()
      if jarr(jget(e, "order_bys"), "orders").length() > 0 {
        raise Refuse(
          "Ordered aggregates (\{name}(... ORDER BY ...)) are not supported.",
        )
      }
      let filter = jget(e, "filter")
      Func(
        name,
        decode_exprs(jarr(e, "children")),
        jbool(e, "distinct"),
        if jnull(filter) {
          None
        } else {
          Some(decode_expr(filter))
        },
      )
    }
    "COMPARISON" => {
      let op : CmpOp = match ty {
        "COMPARE_EQUAL" => Eq
        "COMPARE_NOTEQUAL" => Ne
        "COMPARE_LESSTHAN" => Lt
        "COMPARE_LESSTHANOREQUALTO" => Le
        "COMPARE_GREATERTHAN" => Gt
        "COMPARE_GREATERTHANOREQUALTO" => Ge
        "COMPARE_DISTINCT_FROM" => IsDistinct
        "COMPARE_NOT_DISTINCT_FROM" => NotDistinct
        other => raise Refuse("Unsupported comparison \{other}.")
      }
      Cmp(op, decode_expr(jget(e, "left")), decode_expr(jget(e, "right")))
    }
    "CONJUNCTION" => {
      let kids = decode_exprs(jarr(e, "children"))
      if ty == "CONJUNCTION_AND" {
        And(kids)
      } else {
        Or(kids)
      }
    }
    "OPERATOR" => {
      let kids = decode_exprs(jarr(e, "children"))
      match ty {
        "OPERATOR_NOT" => Not(kids[0])
        "OPERATOR_IS_NULL" => IsNull(kids[0], false)
        "OPERATOR_IS_NOT_NULL" => IsNull(kids[0], true)
        "COMPARE_IN" | "COMPARE_NOT_IN" =>
          InList(kids[0], kids[1:].to_owned(), ty == "COMPARE_NOT_IN")
        "OPERATOR_COALESCE" => Coalesce(kids)
        other => raise Refuse("Unsupported operator \{other}.")
      }
    }
    "BETWEEN" =>
      Between(
        decode_expr(jget(e, "input")),
        decode_expr(jget(e, "lower")),
        decode_expr(jget(e, "upper")),
      )
    "CASE" => {
      let checks = []
      for c in jarr(e, "case_checks") {
        checks.push(
          (decode_expr(jget(c, "when_expr")), decode_expr(jget(c, "then_expr"))),
        )
      }
      Case(checks, decode_expr(jget(e, "else_expr")))
    }
    "CAST" => {
      if jbool(e, "try_cast") {
        raise Refuse(
          "TRY_CAST turns conversion errors into NULL; Power Query would need try ... otherwise per value. Not supported yet; use CAST.",
        )
      }
      let target = jget(e, "cast_type")
      let id = jstr(target, "id")
      let child = decode_expr(jget(e, "child"))
      let scale = if id == "DECIMAL" {
        match jget(jget(target, "type_info"), "scale") {
          Number(n, ..) => n.to_int()
          _ => -1
        }
      } else {
        -1
      }
      fold_cast(child, id, scale)
    }
    "SUBQUERY" => {
      let q = decode_query(jget(jget(e, "subquery"), "node"))
      match jstr(e, "subquery_type") {
        "EXISTS" => Exists(q)
        "ANY" =>
          if jstr(e, "comparison_type") == "COMPARE_EQUAL" {
            InSub(decode_expr(jget(e, "child")), q, false)
          } else {
            raise Refuse(
              "Quantified comparisons (> ANY / < ALL (subquery)) are not supported; rewrite with MIN/MAX in a CTE and a join.",
            )
          }
        "NOT_EXISTS" => Not(Exists(q))
        "SCALAR" =>
          raise Refuse(
            "Scalar subqueries are not supported. Compute the value in a CTE (e.g. SELECT max(x) AS m FROM t) and CROSS JOIN or JOIN it.",
          )
        other => raise Refuse("Unsupported subquery type \{other}.")
      }
    }
    "WINDOW" => raise Refuse(window_refusal)
    "COLLATE" => raise Refuse("COLLATE is not supported.")
    "PARAMETER" =>
      raise Refuse("Prepared-statement parameters ($1, ?) are not supported.")
    "LAMBDA" => raise Refuse("Lambda expressions are not supported.")
    "POSITIONAL_REFERENCE" =>
      raise Refuse("Positional column references (#1) are not supported.")
    other => raise Refuse("Unsupported expression \{other} (\{ty}).")
  }
}

///|
/// Casts of string literals (`DATE '2024-01-02'`, `true`) become literals.
fn fold_cast(child : Expr, id : String, scale : Int) -> Expr raise Refuse {
  match (child, id) {
    (Const(LText(s)), "BOOLEAN") =>
      match s.to_lower() {
        "t" | "true" => Const(LBool(true))
        "f" | "false" => Const(LBool(false))
        _ => Cast(child, id, scale)
      }
    (Const(LText(s)), "DATE") =>
      match parse_date(s) {
        Some((y, m, d)) => Const(LDate(y, m, d))
        None => raise Refuse("Cannot read date literal '\{s}'; use YYYY-MM-DD.")
      }
    (Const(LText(s)), "TIMESTAMP") =>
      match parse_datetime(s) {
        Some(dt) => Const(dt)
        None =>
          raise Refuse(
            "Cannot read timestamp literal '\{s}'; use YYYY-MM-DD HH:MM:SS.",
          )
      }
    (Const(LNull), _) => Const(LNull)
    _ => Cast(child, id, scale)
  }
}

///|
fn digits_value(s : String, start : Int, len : Int) -> Int? {
  if start + len > s.length() {
    return None
  }
  let mut v = 0
  for i = start; i < start + len; i = i + 1 {
    let c = s[i].to_int()
    if c < '0'.to_int() || c > '9'.to_int() {
      return None
    }
    v = v * 10 + (c - '0'.to_int())
  }
  Some(v)
}

///|
fn parse_date(s : String) -> (Int, Int, Int)? {
  if s.length() != 10 || s[4] != '-' || s[7] != '-' {
    return None
  }
  match (digits_value(s, 0, 4), digits_value(s, 5, 2), digits_value(s, 8, 2)) {
    (Some(y), Some(m), Some(d)) => Some((y, m, d))
    _ => None
  }
}

///|
fn parse_datetime(s : String) -> Lit? {
  if s.length() == 10 {
    return match parse_date(s) {
      Some((y, m, d)) => Some(LDateTime(y, m, d, 0, 0, 0))
      None => None
    }
  }
  if s.length() < 19 || (s[10] != ' ' && s[10] != 'T') {
    return None
  }
  match
    (
      parse_date(s.view(end_offset=10).to_owned()),
      digits_value(s, 11, 2),
      digits_value(s, 14, 2),
      digits_value(s, 17, 2),
    ) {
    (Some((y, m, d)), Some(h), Some(mi), Some(sec)) =>
      Some(LDateTime(y, m, d, h, mi, sec))
    _ => None
  }
}

///|
fn decode_value(v : Json) -> Lit raise Refuse {
  if jbool(v, "is_null") {
    return LNull
  }
  let tyj = jget(v, "type")
  let id = jstr(tyj, "id")
  let raw = jget(v, "value")
  match (id, raw) {
    ("VARCHAR", String(s)) => LText(s)
    ("BOOLEAN", True) => LBool(true)
    ("BOOLEAN", False) => LBool(false)
    (
      "INTEGER"
      | "BIGINT"
      | "SMALLINT"
      | "TINYINT"
      | "HUGEINT"
      | "UBIGINT"
      | "UINTEGER"
      | "USMALLINT"
      | "UTINYINT",
      Number(n, repr~),
    ) =>
      match repr {
        Some(r) => LNum(r)
        None => LNum(n.to_int64().to_string())
      }
    ("DOUBLE" | "FLOAT", Number(n, repr~)) =>
      match repr {
        Some(r) => LNum(r)
        None => LNum(n.to_string())
      }
    ("DECIMAL", Number(n, repr~)) => {
      let scale = match jget(jget(tyj, "type_info"), "scale") {
        Number(s, ..) => s.to_int()
        _ => 0
      }
      let digits = match repr {
        Some(r) => r
        None => n.to_int64().to_string()
      }
      LNum(insert_decimal_point(digits, scale))
    }
    ("HUGEINT" | "DECIMAL", String(s)) => LNum(s)
    ("INTERVAL", _) =>
      raise Refuse(
        "INTERVAL arithmetic is not supported; add or subtract a whole number of days (date + 30).",
      )
    _ => raise Refuse("Unsupported literal of type \{id}.")
  }
}

///|
fn insert_decimal_point(digits : String, scale : Int) -> String {
  if scale <= 0 {
    return digits
  }
  let neg = digits.has_prefix("-")
  let body = if neg { digits.view(start_offset=1).to_owned() } else { digits }
  let padded = StringBuilder()
  for _ in 0..<(scale + 1 - body.length()) {
    padded.write_char('0')
  }
  padded.write_string(body)
  let p = padded.to_string()
  let cut = p.length() - scale
  let sb = StringBuilder()
  if neg {
    sb.write_char('-')
  }
  sb.write_string(p.view(end_offset=cut).to_owned())
  sb.write_char('.')
  sb.write_string(p.view(start_offset=cut).to_owned())
  sb.to_string()
}
