///|
/// Translate a DuckDB `json_serialize_sql` document into Power Query M.
///
/// `ast_json` is the raw output of `json_serialize_sql(query)`.
/// `catalog_json` describes the base tables:
/// `{"tables":[{"name":"orders","columns":[{"name":"id","type":"INTEGER"}]}]}`.
///
/// Returns a JSON document: `{"ok":true,"m":"let ...","warnings":[...]}` or
/// `{"ok":false,"error":"..."}`.
pub fn transpile(ast_json : String, catalog_json : String) -> String {
  let result : Json = try {
    let m = compile_document(ast_json, catalog_json)
    { "ok": true, "m": m.text.to_json(), "warnings": m.warnings.to_json() }
  } catch {
    Refuse(msg) => { "ok": false, "error": msg.to_json() }
    err =>
      { "ok": false, "error": ("internal error: " + err.to_string()).to_json() }
  }
  result.stringify()
}
