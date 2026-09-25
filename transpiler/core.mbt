///|
/// A deliberate refusal: the input is outside what sql2m translates faithfully.
priv suberror Refuse {
  Refuse(String)
}

///|
priv struct Output {
  text : String
  warnings : Array[String]
}

///|
/// Coarse value types, only as precise as the M emission needs.
priv enum Ty {
  TNum
  TText
  TDate
  TDateTime
  TBool
  TAny
} derive(Eq)

///|
fn ty_of_duckdb(t : String) -> Ty {
  let u = t.to_upper()
  let num_prefixes = [
    "TINYINT", "SMALLINT", "INTEGER", "INT", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT",
    "UINTEGER", "UBIGINT", "UHUGEINT", "DOUBLE", "FLOAT", "REAL", "DECIMAL", "NUMERIC",
  ]
  for p in num_prefixes {
    if u.has_prefix(p) {
      return TNum
    }
  }
  if u.has_prefix("VARCHAR") ||
    u.has_prefix("TEXT") ||
    u.has_prefix("STRING") ||
    u.has_prefix("CHAR") ||
    u.has_prefix("BPCHAR") {
    return TText
  }
  if u == "DATE" {
    return TDate
  }
  if u.has_prefix("TIMESTAMP") || u == "DATETIME" {
    return TDateTime
  }
  if u == "BOOLEAN" || u == "BOOL" {
    return TBool
  }
  TAny
}

///|
priv struct RelCol {
  name : String
  ty : Ty
  notnull : Bool
}

///|
/// A compiled table-valued thing: an M expression (a step or query name)
/// plus its column names in order.
priv struct Rel {
  ref_ : String
  cols : Array[RelCol]
}

///|
priv struct TableDef {
  name : String
  cols : Array[RelCol]
}

///|
priv struct Step {
  mut name : String
  body : String
  comments : Array[String]
}

///|
priv struct Ctx {
  steps : Array[Step]
  used : Map[String, Bool]
  tables : Map[String, TableDef]
  scopes : Array[Map[String, Rel]]
  warnings : Array[String]
  mut pending : Array[String]
}

///|
fn Ctx::new(tables : Map[String, TableDef]) -> Ctx {
  let used : Map[String, Bool] = Map([])
  for _, t in tables {
    used[t.name] = true
  }
  { steps: [], used, tables, scopes: [], warnings: [], pending: [], }
}

///|
fn Ctx::unique(self : Ctx, base : String) -> String {
  if !self.used.contains(base) {
    return base
  }
  let mut i = 2
  while self.used.contains(base + " " + i.to_string()) {
    i = i + 1
  }
  base + " " + i.to_string()
}

///|
fn Ctx::comment(self : Ctx, line : String) -> Unit {
  self.pending.push(line)
}

///|
/// Appends `Name = body` and returns the M reference to it.
fn Ctx::step(
  self : Ctx,
  prefix : String,
  label : String,
  body : String,
) -> String {
  let base = if prefix == "" { label } else { prefix + ": " + label }
  let name = self.unique(base)
  self.used[name] = true
  self.steps.push({ name, body, comments: self.pending, })
  self.pending = []
  m_ident(name)
}

///|
/// Renames the most recent step (created after `mark`) to `name`, or adds
/// `name = ref` when the relation did not produce a step of its own.
fn Ctx::finish_named(
  self : Ctx,
  mark : Int,
  rel_ref : String,
  name : String,
) -> String {
  let n = self.steps.length()
  if n > mark && m_ident(self.steps[n - 1].name) == rel_ref {
    let last = self.steps[n - 1]
    self.used.remove(last.name)
    let fresh = self.unique(name)
    self.used[fresh] = true
    last.name = fresh
    m_ident(fresh)
  } else {
    self.step("", name, rel_ref)
  }
}

///|
fn Ctx::lookup_relation(self : Ctx, name : String) -> Rel? {
  let key = name.to_lower()
  for i = self.scopes.length() - 1; i >= 0; i = i - 1 {
    if self.scopes[i].get(key) is Some(r) {
      return Some(r)
    }
  }
  match self.tables.get(key) {
    Some(t) => Some({ ref_: m_ident(t.name), cols: t.cols, })
    None => None
  }
}

///|
fn Ctx::render(self : Ctx, final_ref : String) -> String {
  let sb = StringBuilder()
  sb.write_string("let\n")
  let n = self.steps.length()
  for i, s in self.steps {
    for c in s.comments {
      sb.write_string("    // " + c + "\n")
    }
    sb.write_string("    " + m_ident(s.name) + " = " + s.body)
    if i < n - 1 {
      sb.write_string(",")
    }
    sb.write_string("\n")
  }
  sb.write_string("in\n    " + final_ref)
  sb.to_string()
}

///|
fn decode_catalog(catalog_json : String) -> Map[String, TableDef] raise Refuse {
  let doc = @json.parse(catalog_json) catch {
    _ => raise Refuse("internal error: catalog is not valid JSON")
  }
  let tables : Map[String, TableDef] = Map([])
  for t in jarr(doc, "tables") {
    let cols = []
    for c in jarr(t, "columns") {
      cols.push({
        name: jstr(c, "name"),
        ty: ty_of_duckdb(jstr(c, "type")),
        notnull: false,
      })
    }
    let name = jstr(t, "name")
    tables[name.to_lower()] = { name, cols, }
  }
  tables
}

///|
fn compile_document(ast_json : String, catalog_json : String) -> Output raise {
  let doc = @json.parse(ast_json) catch {
    _ => raise Refuse("internal error: parse tree is not valid JSON")
  }
  let query = decode_document(doc)
  let ctx = Ctx::new(decode_catalog(catalog_json))
  let rel = compile_query(ctx, query, "")
  let final_ref = if ctx.steps.length() == 0 {
    ctx.step("", "Source", rel.ref_)
  } else {
    rel.ref_
  }
  { text: ctx.render(final_ref), warnings: ctx.warnings, }
}

// ---------------------------------------------------------------------------
// M lexical helpers

///|
let m_keywords : Array[String] = [
  "and", "as", "each", "else", "error", "false", "if", "in", "is", "let", "meta",
  "not", "null", "or", "otherwise", "section", "shared", "then", "true", "try", "type",
]

///|
fn is_ident_start(c : Char) -> Bool {
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'
}

///|
fn is_ident_char(c : Char) -> Bool {
  is_ident_start(c) || (c >= '0' && c <= '9')
}

///|
/// Identifier for a step or query name: bare when regular, else `#"..."`.
fn m_ident(name : String) -> String {
  let mut ok = name.length() > 0 && !m_keywords.contains(name)
  for i, c in name.to_array() {
    if i == 0 && !is_ident_start(c) {
      ok = false
    }
    if !is_ident_char(c) {
      ok = false
    }
  }
  if ok {
    name
  } else {
    "#" + m_string_body(name)
  }
}

///|
/// Field name inside `[...]` (generalized identifier) or `#"..."`.
fn m_field(name : String) -> String {
  let chars = name.to_array()
  let mut ok = chars.length() > 0
  let mut prev = ' '
  for i, c in chars {
    let good = is_ident_char(c) ||
      (c == ' ' && i > 0 && prev != ' ' && prev != '.') ||
      (c == '.' && i > 0 && prev != ' ' && prev != '.')
    if !good {
      ok = false
    }
    prev = c
  }
  if chars.length() > 0 && (prev == ' ' || prev == '.') {
    ok = false
  }
  if ok {
    name
  } else {
    "#" + m_string_body(name)
  }
}

///|
fn m_string_body(s : String) -> String {
  let sb = StringBuilder()
  sb.write_char('"')
  let chars = s.to_array()
  for i, c in chars {
    match c {
      '"' => sb.write_string("\"\"")
      '\n' => sb.write_string("#(lf)")
      '\r' => sb.write_string("#(cr)")
      '\t' => sb.write_string("#(tab)")
      '#' =>
        if i + 1 < chars.length() && chars[i + 1] == '(' {
          sb.write_string("#(#)")
        } else {
          sb.write_char('#')
        }
      _ => sb.write_char(c)
    }
  }
  sb.write_char('"')
  sb.to_string()
}

///|
fn m_text(s : String) -> String {
  m_string_body(s)
}

///|
fn m_list(items : Array[String]) -> String {
  "{" + items.join(", ") + "}"
}

///|
fn m_text_list(names : Array[String]) -> String {
  m_list(names.map(m_text))
}
