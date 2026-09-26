// SQL expressions -> M expressions.
//
// Two modes:
// * `val`  - the exact SQL value (three-valued logic preserved). M's `and`,
//            `or`, `not`, relational operators and text functions already
//            propagate null the way SQL does; only `=`/`<>` differ (in M,
//            null = null is true), so equality gets explicit null handling.
// * `pred` - a filter condition. The emitted M is true exactly when the SQL
//            predicate is TRUE (positive) or FALSE (negative); a null result
//            only ever means "not true", which Table.SelectRows treats as
//            dropping the row. NOT is pushed down (De Morgan) so no M `not`
//            is ever applied to a comparison that could be wrong about null.

///|
priv struct FCol {
  qual : String
  name : String
  m : String
  ty : Ty
  hidden : Bool
  notnull : Bool
}

///|
/// Columns in scope at some point of a SELECT, over the M table `ref_`.
priv struct Frame {
  ref_ : String
  cols : Array[FCol]
}

///|
priv struct Env {
  /// frame + row variable ("" = the implicit `_` of `each`)
  frames : Array[(Frame, String)]
  /// grouped expressions already materialised as columns of frames[0]
  rewrite : Array[(Expr, String, Ty)]
  /// resolve unqualified names against the last frame first (subqueries)
  prefer_last : Bool
}

///|
fn env1(f : Frame) -> Env {
  { frames: [(f, "")], rewrite: [], prefer_last: false, }
}

///|
priv struct MExpr {
  text : String
  prec : Int
  ty : Ty
  nullable : Bool
}

///|
const ATOM = 100

///|
const UNARY = 90

///|
const MUL = 80

///|
const ADD = 70

///|
const REL = 60

///|
const EQ = 50

///|
const AND = 40

///|
const OR = 30

///|
const COALESCE = 20

///|
const IF = 10

///|
fn wrap(e : MExpr, min : Int) -> String {
  if e.prec < min {
    "(" + e.text + ")"
  } else {
    e.text
  }
}

///|
fn atom(text : String, ty : Ty, nullable : Bool) -> MExpr {
  { text, prec: ATOM, ty, nullable, }
}

///|
fn call(f : String, args : Array[String], ty : Ty, nullable : Bool) -> MExpr {
  atom(f + "(" + args.join(", ") + ")", ty, nullable)
}

///|
fn bin(op : String, prec : Int, a : MExpr, b : MExpr, ty : Ty) -> MExpr {
  {
    text: wrap(a, prec) + " " + op + " " + wrap(b, prec + 1),
    prec,
    ty,
    nullable: a.nullable || b.nullable,
  }
}

///|
fn join_op(op : String, prec : Int, parts : Array[MExpr]) -> MExpr {
  let texts = []
  let mut nullable = false
  for p in parts {
    texts.push(wrap(p, prec))
    nullable = nullable || p.nullable
  }
  { text: texts.join(" " + op + " "), prec, ty: TBool, nullable, }
}

///|
fn m_true() -> MExpr {
  atom("true", TBool, false)
}

///|
fn m_false() -> MExpr {
  atom("false", TBool, false)
}

///|
fn m_null() -> MExpr {
  atom("null", TAny, true)
}

// ---------------------------------------------------------------------------
// Column resolution

///|
fn col_display(names : Array[String]) -> String {
  names.join(".")
}

///|
/// Finds a column; returns (frame index, column).
fn resolve(env : Env, names : Array[String]) -> (Int, FCol) raise Refuse {
  let n = names.length()
  if n == 0 {
    raise Refuse("internal error: empty column reference")
  }
  let col = names[n - 1].to_lower()
  let qual = if n >= 2 { names[n - 2].to_lower() } else { "" }
  let found : Array[(Int, FCol)] = []
  let order : Array[Int] = []
  if env.prefer_last {
    for i = env.frames.length() - 1; i >= 0; i = i - 1 {
      order.push(i)
    }
  } else {
    for i = 0; i < env.frames.length(); i = i + 1 {
      order.push(i)
    }
  }
  for i in order {
    let (frame, _) = env.frames[i]
    for c in frame.cols {
      if c.name.to_lower() != col {
        continue
      }
      if qual == "" {
        if !c.hidden {
          found.push((i, c))
        }
      } else if c.qual == qual {
        found.push((i, c))
      }
    }
    if env.prefer_last && found.length() > 0 {
      break
    }
  }
  if found.length() == 0 {
    raise Refuse("Unknown column \{col_display(names)}.")
  }
  if found.length() > 1 {
    raise Refuse(
      "Column \{col_display(names)} is ambiguous here; qualify it with a table alias.",
    )
  }
  found[0]
}

///|
fn access(rv : String, m : String) -> String {
  rv + "[" + m_field(m) + "]"
}

///|
fn col_expr(env : Env, names : Array[String]) -> MExpr raise Refuse {
  let (i, c) = resolve(env, names)
  let (_, rv) = env.frames[i]
  atom(access(rv, c.m), c.ty, !c.notnull)
}

///|
/// Which frames an expression reads (for classifying join conditions).
fn frames_used(env : Env, e : Expr, acc : Array[Bool]) -> Unit raise Refuse {
  match e {
    Col(names) => {
      let (i, _) = resolve(env, names)
      acc[i] = true
    }
    Const(_) | Star(_, _) => ()
    Func(_, args, _, filter) => {
      for a in args {
        frames_used(env, a, acc)
      }
      if filter is Some(f) {
        frames_used(env, f, acc)
      }
    }
    Cmp(_, a, b) => {
      frames_used(env, a, acc)
      frames_used(env, b, acc)
    }
    And(ks) | Or(ks) | Coalesce(ks) =>
      for k in ks {
        frames_used(env, k, acc)
      }
    Not(a) | IsNull(a, _) | Cast(a, _, _) => frames_used(env, a, acc)
    InList(a, ks, _) => {
      frames_used(env, a, acc)
      for k in ks {
        frames_used(env, k, acc)
      }
    }
    Between(a, b, c) => {
      frames_used(env, a, acc)
      frames_used(env, b, acc)
      frames_used(env, c, acc)
    }
    Case(checks, other) => {
      for wt in checks {
        frames_used(env, wt.0, acc)
        frames_used(env, wt.1, acc)
      }
      frames_used(env, other, acc)
    }
    InSub(_, _, _) | Exists(_) =>
      raise Refuse(
        "Subqueries are only supported as whole WHERE conditions (EXISTS, NOT EXISTS, IN (SELECT ...)).",
      )
    Window(_) => raise Refuse(window_placement)
  }
}

///|
let window_placement : String = "Window functions (... OVER (...)) are only allowed in SELECT, QUALIFY and ORDER BY."

// ---------------------------------------------------------------------------
// Literals

///|
fn lit(l : Lit) -> MExpr {
  match l {
    LNull => m_null()
    LBool(b) => if b { m_true() } else { m_false() }
    LNum(s) =>
      if s.has_prefix("-") {
        { text: s, prec: UNARY, ty: TNum, nullable: false, }
      } else {
        atom(s, TNum, false)
      }
    LText(s) => atom(m_text(s), TText, false)
    LDate(y, m, d) => atom("#date(\{y}, \{m}, \{d})", TDate, false)
    LDateTime(y, mo, d, h, mi, s) =>
      atom("#datetime(\{y}, \{mo}, \{d}, \{h}, \{mi}, \{s})", TDateTime, false)
  }
}

///|
/// SQL implicitly casts a string literal compared with a date or number.
fn coerce_literal(e : Expr, ty : Ty) -> Expr raise Refuse {
  match (e, ty) {
    (Const(LText(s)), TDate) =>
      match parse_date(s) {
        Some((y, m, d)) => Const(LDate(y, m, d))
        None =>
          raise Refuse("Cannot compare a date with '\{s}'; use YYYY-MM-DD.")
      }
    (Const(LText(s)), TDateTime) =>
      match parse_datetime(s) {
        Some(dt) => Const(dt)
        None =>
          raise Refuse(
            "Cannot compare a timestamp with '\{s}'; use YYYY-MM-DD HH:MM:SS.",
          )
      }
    (Const(LText(s)), TNum) => {
      let ok = s.length() > 0 &&
        s
        .to_array()
        .all(fn(c) { (c >= '0' && c <= '9') || c == '.' || c == '-' })
      if ok {
        Const(LNum(s))
      } else {
        e
      }
    }
    _ => e
  }
}

///|
fn is_null_lit(e : Expr) -> Bool {
  e is Const(LNull)
}

///|
/// Compiles both sides of a comparison, coercing string literals to the
/// other side's type.
fn val_pair(env : Env, a : Expr, b : Expr) -> (MExpr, MExpr) raise Refuse {
  match (a, b) {
    (Const(LText(_)), Const(_)) => (val(env, a), val(env, b))
    (Const(LText(_)), _) => {
      let mb = val(env, b)
      (val(env, coerce_literal(a, mb.ty)), mb)
    }
    (_, Const(LText(_))) => {
      let ma = val(env, a)
      (ma, val(env, coerce_literal(b, ma.ty)))
    }
    _ => (val(env, a), val(env, b))
  }
}

// ---------------------------------------------------------------------------
// Values

///|
fn rewritten(env : Env, e : Expr) -> MExpr? {
  for r in env.rewrite {
    if r.0 == e {
      let (_, rv) = env.frames[0]
      return Some(atom(access(rv, r.1), r.2, true))
    }
  }
  None
}

///|
fn val(env : Env, e : Expr) -> MExpr raise Refuse {
  if rewritten(env, e) is Some(m) {
    return m
  }
  match e {
    Col(names) => col_expr(env, names)
    Const(l) => lit(l)
    Star(_, _) => raise Refuse("* is only allowed directly in the SELECT list.")
    Func(name, args, distinct, filter) =>
      val_func(env, name, args, distinct, filter)
    Cmp(op, a, b) => {
      if is_null_lit(a) || is_null_lit(b) {
        return match op {
          IsDistinct | NotDistinct => {
            let (ma, mb) = val_pair(env, a, b)
            bin(if op == IsDistinct { "<>" } else { "=" }, EQ, ma, mb, TBool)
          }
          _ => m_null()
        }
      }
      let (ma, mb) = val_pair(env, a, b)
      match op {
        Eq | Ne => {
          let core = bin(if op == Eq { "=" } else { "<>" }, EQ, ma, mb, TBool)
          let guards = []
          if ma.nullable {
            guards.push(wrap(ma, EQ + 1) + " = null")
          }
          if mb.nullable {
            guards.push(wrap(mb, EQ + 1) + " = null")
          }
          if guards.length() == 0 {
            core
          } else {
            {
              text: "if " + guards.join(" or ") + " then null else " + core.text,
              prec: IF,
              ty: TBool,
              nullable: true,
            }
          }
        }
        Lt => bin("<", REL, ma, mb, TBool)
        Le => bin("<=", REL, ma, mb, TBool)
        Gt => bin(">", REL, ma, mb, TBool)
        Ge => bin(">=", REL, ma, mb, TBool)
        IsDistinct => { ..bin("<>", EQ, ma, mb, TBool), nullable: false, }
        NotDistinct => { ..bin("=", EQ, ma, mb, TBool), nullable: false, }
      }
    }
    And(ks) => join_op("and", AND, vals(env, ks))
    Or(ks) => join_op("or", OR, vals(env, ks))
    Not(a) => {
      let ma = val(env, a)
      {
        text: "not " + wrap(ma, ATOM),
        prec: UNARY,
        ty: TBool,
        nullable: ma.nullable,
      }
    }
    IsNull(a, negated) => {
      let ma = val(env, a)
      {
        text: wrap(ma, EQ + 1) + (if negated { " <> null" } else { " = null" }),
        prec: EQ,
        ty: TBool,
        nullable: false,
      }
    }
    InList(x, items, negated) => {
      let (mx, list, had_null) = in_list_parts(env, x, items)
      let contains = call("List.Contains", [list, mx.text], TBool, false)
      let v : MExpr = if had_null {
        {
          text: "if " + contains.text + " then true else null",
          prec: IF,
          ty: TBool,
          nullable: true,
        }
      } else if mx.nullable {
        {
          text: "if " +
          wrap(mx, EQ + 1) +
          " = null then null else " +
          contains.text,
          prec: IF,
          ty: TBool,
          nullable: true,
        }
      } else {
        contains
      }
      if negated {
        {
          text: "not " + wrap(v, ATOM),
          prec: UNARY,
          ty: TBool,
          nullable: v.nullable,
        }
      } else {
        v
      }
    }
    Between(x, lo, hi) => {
      let (mx, mlo) = val_pair(env, x, lo)
      let (_, mhi) = val_pair(env, x, hi)
      join_op("and", AND, [
        bin(">=", REL, mx, mlo, TBool),
        bin("<=", REL, mx, mhi, TBool),
      ])
    }
    Case(checks, other) => {
      let sb = StringBuilder()
      let mut ty = TAny
      let mut nullable = false
      for wt in checks {
        let then_ = val(env, wt.1)
        if ty == TAny {
          ty = then_.ty
        }
        nullable = nullable || then_.nullable
        sb.write_string(
          "if " +
          cond_text(env, wt.0) +
          " then " +
          wrap(then_, IF + 1) +
          " else ",
        )
      }
      let else_ = val(env, other)
      if ty == TAny {
        ty = else_.ty
      }
      sb.write_string(wrap(else_, IF))
      {
        text: sb.to_string(),
        prec: IF,
        ty,
        nullable: nullable || else_.nullable,
      }
    }
    Cast(x, target, scale) => val_cast(env, x, target, scale)
    Coalesce(ks) => {
      let parts = vals(env, ks)
      let texts = []
      for i, p in parts {
        texts.push(
          wrap(p, if i == parts.length() - 1 { COALESCE } else { COALESCE + 1 }),
        )
      }
      let last = parts[parts.length() - 1]
      let mut ty = TAny
      for p in parts {
        if ty == TAny {
          ty = p.ty
        }
      }
      { text: texts.join(" ?? "), prec: COALESCE, ty, nullable: last.nullable, }
    }
    InSub(_, _, _) | Exists(_) =>
      raise Refuse(
        "Subqueries are only supported as whole WHERE conditions (EXISTS, NOT EXISTS, IN (SELECT ...)).",
      )
    Window(_) => raise Refuse(window_placement)
  }
}

///|
fn in_list_parts(
  env : Env,
  x : Expr,
  items : Array[Expr],
) -> (MExpr, String, Bool) raise Refuse {
  let mx = val(env, x)
  let texts = []
  let mut had_null = false
  for it in items {
    if is_null_lit(it) {
      had_null = true
    } else {
      texts.push(val(env, coerce_literal(it, mx.ty)).text)
    }
  }
  (mx, m_list(texts), had_null)
}

///|
/// Condition of an M `if`: must never be null (M raises an error on
/// `if null`), so a possibly-null predicate is compared with true.
fn cond_text(env : Env, e : Expr) -> String raise Refuse {
  let p = pred(env, e, true)
  if p.nullable {
    wrap(p, EQ + 1) + " = true"
  } else {
    wrap(p, IF + 1)
  }
}

///|
fn text_of(m : MExpr) -> String {
  match m.ty {
    TText => m.text
    TNum => "Text.From(" + m.text + ", \"en-US\")"
    TDate => "Date.ToText(" + m.text + ", [Format = \"yyyy-MM-dd\"])"
    TDateTime =>
      "DateTime.ToText(" + m.text + ", [Format = \"yyyy-MM-dd HH:mm:ss\"])"
    _ => "Text.From(" + m.text + ")"
  }
}

///|
fn val_cast(
  env : Env,
  x : Expr,
  target : String,
  scale : Int,
) -> MExpr raise Refuse {
  let mx = val(env, x)
  match target {
    "VARCHAR" =>
      if mx.ty == TText {
        mx
      } else {
        atom(text_of(mx), TText, mx.nullable)
      }
    "INTEGER"
    | "BIGINT"
    | "SMALLINT"
    | "TINYINT"
    | "HUGEINT"
    | "UBIGINT"
    | "UINTEGER" =>
      call(
        "Int64.From",
        [mx.text, "\"en-US\"", "RoundingMode.AwayFromZero"],
        TNum,
        mx.nullable,
      )
    "DOUBLE" | "FLOAT" | "REAL" =>
      if mx.ty == TNum {
        mx
      } else {
        call("Number.From", [mx.text, "\"en-US\""], TNum, mx.nullable)
      }
    "DECIMAL" => {
      let n = if mx.ty == TNum {
        mx
      } else {
        call("Number.From", [mx.text, "\"en-US\""], TNum, mx.nullable)
      }
      if scale >= 0 {
        call(
          "Number.Round",
          [n.text, scale.to_string(), "RoundingMode.AwayFromZero"],
          TNum,
          mx.nullable,
        )
      } else {
        n
      }
    }
    "DATE" =>
      if mx.ty == TDate {
        mx
      } else {
        call("Date.From", [mx.text], TDate, mx.nullable)
      }
    "BOOLEAN" =>
      if mx.ty == TBool {
        mx
      } else {
        call("Logical.From", [mx.text], TBool, mx.nullable)
      }
    other => raise Refuse("CAST to \{other} is not supported.")
  }
}

///|
let aggregate_names : Array[String] = [
  "sum", "count", "count_star", "avg", "mean", "min", "max", "string_agg", "group_concat",
  "listagg", "any_value",
]

///|
fn is_aggregate(e : Expr) -> Bool {
  match e {
    Func(name, _, _, _) => aggregate_names.contains(name)
    _ => false
  }
}

///|
fn arity(
  name : String,
  args : Array[Expr],
  lo : Int,
  hi : Int,
) -> Unit raise Refuse {
  if args.length() < lo || args.length() > hi {
    raise Refuse("\{name}() called with \{args.length()} arguments.")
  }
}

///|
fn any_nullable(ms : Array[MExpr]) -> Bool {
  ms.iter().any(fn(m) { m.nullable })
}

///|
fn val_func(
  env : Env,
  name : String,
  args : Array[Expr],
  distinct : Bool,
  filter : Expr?,
) -> MExpr raise Refuse {
  if aggregate_names.contains(name) {
    raise Refuse(
      "Aggregate \{name}() is not allowed here (only in SELECT/HAVING/ORDER BY of a grouped query).",
    )
  }
  if distinct || filter is Some(_) {
    raise Refuse("DISTINCT / FILTER only apply to aggregate functions.")
  }
  if name.has_prefix("~~") || name.has_prefix("!~~") {
    return val(env, like_to_expr(name, args))
  }
  let ms = vals(env, args)
  let n = any_nullable(ms)
  fn one(f : String, ty : Ty) -> MExpr raise Refuse {
    arity(name, args, 1, 1)
    call(f, [ms[0].text], ty, n)
  }

  match name {
    "+" =>
      if ms.length() == 1 {
        ms[0]
      } else if ms[0].ty == TDate && ms[1].ty == TNum {
        call("Date.AddDays", [ms[0].text, ms[1].text], TDate, n)
      } else if ms[0].ty == TNum && ms[1].ty == TDate {
        call("Date.AddDays", [ms[1].text, ms[0].text], TDate, n)
      } else {
        bin("+", ADD, ms[0], ms[1], TNum)
      }
    "-" =>
      if ms.length() == 1 {
        { text: "-" + wrap(ms[0], ATOM), prec: UNARY, ty: TNum, nullable: n, }
      } else if ms[0].ty == TDate && ms[1].ty == TNum {
        call("Date.AddDays", [ms[0].text, "-" + wrap(ms[1], ATOM)], TDate, n)
      } else if ms[0].ty == TDate && ms[1].ty == TDate {
        call("Duration.Days", [bin("-", ADD, ms[0], ms[1], TAny).text], TNum, n)
      } else {
        bin("-", ADD, ms[0], ms[1], TNum)
      }
    "*" => bin("*", MUL, ms[0], ms[1], TNum)
    "/" => bin("/", MUL, ms[0], ms[1], TNum)
    "//" => call("Number.IntegerDivide", [ms[0].text, ms[1].text], TNum, n)
    "%" | "mod" => call("Number.Mod", [ms[0].text, ms[1].text], TNum, n)
    "||" => {
      let a = atom(text_of(ms[0]), TText, ms[0].nullable)
      let b = atom(text_of(ms[1]), TText, ms[1].nullable)
      let a = if ms[0].ty == TText { ms[0] } else { a }
      let b = if ms[1].ty == TText { ms[1] } else { b }
      bin("&", ADD, a, b, TText)
    }
    "concat" => call("Text.Combine", [m_list(ms.map(text_of))], TText, false)
    "concat_ws" => {
      arity(name, args, 2, 100)
      call(
        "Text.Combine",
        [m_list(ms[1:].to_owned().map(text_of)), ms[0].text],
        TText,
        ms[0].nullable,
      )
    }
    "lower" | "lcase" => one("Text.Lower", TText)
    "upper" | "ucase" => one("Text.Upper", TText)
    "trim" => one("Text.Trim", TText)
    "ltrim" => one("Text.TrimStart", TText)
    "rtrim" => one("Text.TrimEnd", TText)
    "length" | "len" | "char_length" | "character_length" | "strlen" =>
      one("Text.Length", TNum)
    "substring" | "substr" => {
      arity(name, args, 2, 3)
      let start = match args[1] {
        Const(LNum(s)) =>
          match digits_value(s, 0, s.length()) {
            Some(k) if k >= 1 => (k - 1).to_string()
            _ =>
              raise Refuse(
                "substring() start must be a positive literal to translate safely.",
              )
          }
        _ => wrap(ms[1], ADD) + " - 1"
      }
      let a = [ms[0].text, start]
      if ms.length() == 3 {
        a.push(ms[2].text)
      }
      call("Text.Middle", a, TText, n)
    }
    "left" => call("Text.Start", [ms[0].text, ms[1].text], TText, n)
    "right" => call("Text.End", [ms[0].text, ms[1].text], TText, n)
    "replace" => {
      arity(name, args, 3, 3)
      call("Text.Replace", [ms[0].text, ms[1].text, ms[2].text], TText, n)
    }
    "contains" => call("Text.Contains", [ms[0].text, ms[1].text], TBool, n)
    "starts_with" | "prefix" =>
      call("Text.StartsWith", [ms[0].text, ms[1].text], TBool, n)
    "ends_with" | "suffix" =>
      call("Text.EndsWith", [ms[0].text, ms[1].text], TBool, n)
    "abs" => one("Number.Abs", TNum)
    "round" => {
      arity(name, args, 1, 2)
      let digits = if ms.length() == 2 { ms[1].text } else { "0" }
      call(
        "Number.Round",
        [ms[0].text, digits, "RoundingMode.AwayFromZero"],
        TNum,
        n,
      )
    }
    "ceil" | "ceiling" => one("Number.RoundUp", TNum)
    "floor" => one("Number.RoundDown", TNum)
    "nullif" => {
      arity(name, args, 2, 2)
      {
        text: "if " +
        bin("=", EQ, ms[0], ms[1], TBool).text +
        " then null else " +
        wrap(ms[0], IF),
        prec: IF,
        ty: ms[0].ty,
        nullable: true,
      }
    }
    "ifnull" => {
      arity(name, args, 2, 2)
      {
        text: wrap(ms[0], COALESCE + 1) + " ?? " + wrap(ms[1], COALESCE),
        prec: COALESCE,
        ty: ms[0].ty,
        nullable: ms[1].nullable,
      }
    }
    "greatest" =>
      call("List.Max", [m_list(ms.map(fn(m : MExpr) { m.text }))], ms[0].ty, n)
    "least" =>
      call("List.Min", [m_list(ms.map(fn(m : MExpr) { m.text }))], ms[0].ty, n)
    "year" => one("Date.Year", TNum)
    "month" => one("Date.Month", TNum)
    "day" | "dayofmonth" => one("Date.Day", TNum)
    "date_part" | "datepart" | "extract" => {
      arity(name, args, 2, 2)
      let f = match args[0] {
        Const(LText(p)) =>
          match p.to_lower() {
            "year" | "years" | "y" => "Date.Year"
            "month" | "months" | "mon" => "Date.Month"
            "day" | "days" | "d" => "Date.Day"
            other =>
              raise Refuse("date_part('\{other}', ...) is not supported.")
          }
        _ => raise Refuse("date_part() needs a literal part name.")
      }
      call(f, [ms[1].text], TNum, ms[1].nullable)
    }
    "date_diff" | "datediff" => {
      arity(name, args, 3, 3)
      match args[0] {
        Const(LText(p)) if p.to_lower() == "day" || p.to_lower() == "days" =>
          call(
            "Duration.Days",
            [wrap(ms[2], ADD) + " - " + wrap(ms[1], ADD + 1)],
            TNum,
            n,
          )
        _ => raise Refuse("date_diff() is only supported with 'day'.")
      }
    }
    "if" | "iff" => {
      arity(name, args, 3, 3)
      {
        text: "if " +
        cond_text(env, args[0]) +
        " then " +
        wrap(ms[1], IF + 1) +
        " else " +
        wrap(ms[2], IF),
        prec: IF,
        ty: ms[1].ty,
        nullable: ms[1].nullable || ms[2].nullable,
      }
    }
    _ => raise Refuse("Function \{name}() is not supported yet.")
  }
}

// ---------------------------------------------------------------------------
// LIKE

///|
priv enum LikeShape {
  LikeExact(String)
  LikePrefix(String)
  LikeSuffix(String)
  LikeContains(String)
  LikeAny
}

///|
fn like_shape(pattern : String) -> LikeShape raise Refuse {
  let chars = pattern.to_array()
  if chars.contains('_') {
    raise Refuse(
      "LIKE patterns with _ are not supported; only 'abc', 'abc%', '%abc', '%abc%' translate to Text functions.",
    )
  }
  let n = chars.length()
  let lead = n > 0 && chars[0] == '%'
  let trail = n > 0 && chars[n - 1] == '%'
  let inner = StringBuilder()
  let mut percents_inside = false
  for i, c in chars {
    if c == '%' {
      if !((i == 0 && lead) || (i == n - 1 && trail)) {
        percents_inside = true
      }
    } else {
      inner.write_char(c)
    }
  }
  if percents_inside {
    raise Refuse(
      "LIKE patterns with % in the middle are not supported; only 'abc', 'abc%', '%abc', '%abc%' translate to Text functions.",
    )
  }
  let s = inner.to_string()
  if s == "" && (lead || trail) {
    return LikeAny
  }
  match (lead, trail) {
    (false, false) => LikeExact(s)
    (false, true) => LikePrefix(s)
    (true, false) => LikeSuffix(s)
    (true, true) => LikeContains(s)
  }
}

///|
/// LIKE rewritten as the equivalent comparison / Text-function call, so the
/// value and predicate rules (null handling included) apply unchanged.
fn like_to_expr(name : String, args : Array[Expr]) -> Expr raise Refuse {
  arity(name, args, 2, 2)
  let negated = name.has_prefix("!")
  let insensitive = name.has_suffix("*")
  let pattern = match args[1] {
    Const(LText(p)) => if insensitive { p.to_lower() } else { p }
    _ => raise Refuse("LIKE needs a literal pattern.")
  }
  let x = if insensitive {
    Func("lower", [args[0]], false, None)
  } else {
    args[0]
  }
  let core : Expr = match like_shape(pattern) {
    LikeExact(s) => Cmp(Eq, x, Const(LText(s)))
    LikeAny => IsNull(x, true)
    LikePrefix(s) => Func("starts_with", [x, Const(LText(s))], false, None)
    LikeSuffix(s) => Func("ends_with", [x, Const(LText(s))], false, None)
    LikeContains(s) => Func("contains", [x, Const(LText(s))], false, None)
  }
  if negated {
    Not(core)
  } else {
    core
  }
}

// ---------------------------------------------------------------------------
// Predicates

///|
fn pred(env : Env, e : Expr, pos : Bool) -> MExpr raise Refuse {
  if rewritten(env, e) is Some(m) {
    return if pos {
      m
    } else {
      { text: "not " + wrap(m, ATOM), prec: UNARY, ty: TBool, nullable: true, }
    }
  }
  match e {
    And(ks) | Or(ks) => {
      let is_and = e is And(_)
      let parts = preds(env, ks, pos)
      if is_and == pos {
        join_op("and", AND, parts)
      } else {
        join_op("or", OR, parts)
      }
    }
    Not(a) => pred(env, a, !pos)
    Const(LBool(b)) => if b == pos { m_true() } else { m_false() }
    Const(LNull) => m_false()
    Cmp(op, a, b) => {
      if is_null_lit(a) || is_null_lit(b) {
        match op {
          IsDistinct | NotDistinct => ()
          _ => return m_false()
        }
      }
      let (ma, mb) = val_pair(env, a, b)
      let eff = if pos { op } else { negate_cmp(op) }
      match eff {
        Eq =>
          if ma.nullable && mb.nullable {
            join_op("and", AND, [
              {
                text: wrap(ma, EQ + 1) + " <> null",
                prec: EQ,
                ty: TBool,
                nullable: false,
              },
              bin("=", EQ, ma, mb, TBool),
            ])
            |> no_null
          } else {
            bin("=", EQ, ma, mb, TBool) |> no_null
          }
        Ne => {
          let parts = []
          if ma.nullable {
            parts.push({
              text: wrap(ma, EQ + 1) + " <> null",
              prec: EQ,
              ty: TBool,
              nullable: false,
            })
          }
          if mb.nullable {
            parts.push({
              text: wrap(mb, EQ + 1) + " <> null",
              prec: EQ,
              ty: TBool,
              nullable: false,
            })
          }
          parts.push(bin("<>", EQ, ma, mb, TBool))
          join_op("and", AND, parts) |> no_null
        }
        Lt => bin("<", REL, ma, mb, TBool)
        Le => bin("<=", REL, ma, mb, TBool)
        Gt => bin(">", REL, ma, mb, TBool)
        Ge => bin(">=", REL, ma, mb, TBool)
        IsDistinct => bin("<>", EQ, ma, mb, TBool) |> no_null
        NotDistinct => bin("=", EQ, ma, mb, TBool) |> no_null
      }
    }
    IsNull(a, negated) => {
      let ma = val(env, a)
      let test_null = pos != negated
      {
        text: wrap(ma, EQ + 1) +
        (if test_null { " = null" } else { " <> null" }),
        prec: EQ,
        ty: TBool,
        nullable: false,
      }
    }
    InList(x, items, negated) => {
      let is_member = pos != negated
      let (mx, list, had_null) = in_list_parts(env, x, items)
      let contains = call("List.Contains", [list, mx.text], TBool, false)
      if is_member {
        contains
      } else if had_null {
        m_false()
      } else {
        let not_contains = {
          text: "not " + contains.text,
          prec: UNARY,
          ty: TBool,
          nullable: false,
        }
        if mx.nullable {
          join_op("and", AND, [
            {
              text: wrap(mx, EQ + 1) + " <> null",
              prec: EQ,
              ty: TBool,
              nullable: false,
            },
            not_contains,
          ])
        } else {
          not_contains
        }
      }
    }
    Between(x, lo, hi) => {
      let (mx, mlo) = val_pair(env, x, lo)
      let (_, mhi) = val_pair(env, x, hi)
      if pos {
        join_op("and", AND, [
          bin(">=", REL, mx, mlo, TBool),
          bin("<=", REL, mx, mhi, TBool),
        ])
      } else {
        join_op("or", OR, [
          bin("<", REL, mx, mlo, TBool),
          bin(">", REL, mx, mhi, TBool),
        ])
      }
    }
    Func(name, args, _, _) if name.has_prefix("~~") || name.has_prefix("!~~") =>
      pred(env, like_to_expr(name, args), pos)
    InSub(_, _, _) | Exists(_) =>
      raise Refuse(
        "Subqueries are only supported as whole WHERE conditions (EXISTS, NOT EXISTS, IN (SELECT ...)), not inside OR/NOT/CASE.",
      )
    _ => {
      let v = val(env, e)
      if pos {
        v
      } else {
        {
          text: "not " + wrap(v, ATOM),
          prec: UNARY,
          ty: TBool,
          nullable: v.nullable,
        }
      }
    }
  }
}

///|
fn no_null(m : MExpr) -> MExpr {
  { ..m, nullable: false, }
}

///|
fn negate_cmp(op : CmpOp) -> CmpOp {
  match op {
    Eq => Ne
    Ne => Eq
    Lt => Ge
    Le => Gt
    Gt => Le
    Ge => Lt
    IsDistinct => NotDistinct
    NotDistinct => IsDistinct
  }
}

///|
fn split_and(e : Expr) -> Array[Expr] {
  match e {
    And(ks) => {
      let out = []
      for k in ks {
        for x in split_and(k) {
          out.push(x)
        }
      }
      out
    }
    _ => [e]
  }
}

///|
fn vals(env : Env, es : Array[Expr]) -> Array[MExpr] raise Refuse {
  let out = []
  for e in es {
    out.push(val(env, e))
  }
  out
}

///|
fn preds(env : Env, es : Array[Expr], pos : Bool) -> Array[MExpr] raise Refuse {
  let out = []
  for e in es {
    out.push(pred(env, e, pos))
  }
  out
}
