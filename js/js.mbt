///|
pub fn transpile(ast_json : String, catalog_json : String) -> String {
  @transpiler.transpile(ast_json, catalog_json)
}
