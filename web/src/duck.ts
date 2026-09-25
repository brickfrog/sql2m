// DuckDB-WASM, self-hosted: engine, workers, and the json extension are all
// served from this site's own origin. Nothing is fetched from anywhere else.
import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { type Column, fakeInsert, sqlIdent, sqlString } from './fakedata';

/** The parts of an Apache Arrow result table that the page reads. `typeId` is arrow's `Type` enum. */
export interface ResultTable {
  numRows: number;
  schema: { fields: { name: string; typeId: number }[] };
  getChildAt(index: number): { get(row: number): unknown } | null;
}

export interface Relation {
  name: string;
  isView: boolean;
}

/** Shape of the parts of `json_serialize_sql` output this module reads. */
interface SerializedSql {
  error?: boolean;
  error_message?: string;
  statements: { node: { cte_map: { map: { key: string }[] }; from_table: { table_name: string } } }[];
}

export interface CteCount {
  name: string;
  count?: number;
  error?: string;
}

/** Absolute same-origin URL: the worker runs from a blob: URL, where relative URLs do not resolve. */
const absolute = (url: string): string => new URL(url, document.baseURI).href;

export class Duck {
  private constructor(
    private readonly conn: duckdb.AsyncDuckDBConnection,
    private readonly countTemplate: SerializedSql,
  ) {}

  static async open(): Promise<Duck> {
    const bundle = await duckdb.selectBundle({
      mvp: { mainModule: absolute(mvpWasm), mainWorker: absolute(mvpWorker) },
      eh: { mainModule: absolute(ehWasm), mainWorker: absolute(ehWorker) },
    });
    // A worker started from a blob: URL inherits this page's Content-Security-Policy,
    // so connect-src 'self' also binds everything the engine fetches. A worker
    // started straight from its own URL would get no policy from the <meta> tag.
    const bootstrap = URL.createObjectURL(
      new Blob([`importScripts(${JSON.stringify(bundle.mainWorker)});`], { type: 'text/javascript' }),
    );
    const worker = new Worker(bootstrap);
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await db.instantiate(bundle.mainModule);
    URL.revokeObjectURL(bootstrap);
    await db.open({ query: { castDecimalToDouble: true } });
    const conn = await db.connect();

    // Never fetch extensions implicitly. json (for json_serialize_sql) is loaded
    // explicitly from the copy served next to this page. Then turn off every
    // file/URL access path and freeze the configuration, so typed SQL cannot
    // read from or send to a URL either.
    const repository = absolute('duckdb-extensions').replace(/\/$/, '');
    await conn.query(`
      SET autoinstall_known_extensions = false;
      SET autoload_known_extensions = false;
      SET custom_extension_repository = ${sqlString(repository)};
      LOAD json;
      SET enable_external_access = false;
      SET lock_configuration = true;
    `);

    const template = await serializeWith(conn, 'SELECT count(*) AS n FROM __cte__');
    return new Duck(conn, JSON.parse(template) as SerializedSql);
  }

  query(sql: string): Promise<ResultTable> {
    return this.conn.query(sql);
  }

  /** Raw `json_serialize_sql` output: either the AST or `{"error":true,"error_message":...}`. */
  serialize(sql: string): Promise<string> {
    return serializeWith(this.conn, sql);
  }

  async relations(): Promise<Relation[]> {
    const t = await this.conn.query(
      `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name`,
    );
    return t.toArray().map((r) => ({ name: String(r.table_name), isView: r.table_type === 'VIEW' }));
  }

  async columns(): Promise<Map<string, Column[]>> {
    const t = await this.conn.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'main' ORDER BY table_name, ordinal_position`,
    );
    const byTable = new Map<string, Column[]>();
    for (const r of t.toArray()) {
      const name = String(r.table_name);
      const cols = byTable.get(name) ?? [];
      cols.push({ name: String(r.column_name), type: String(r.data_type) });
      byTable.set(name, cols);
    }
    return byTable;
  }

  /** Catalog JSON for the transpiler contract. */
  async catalogJson(): Promise<string> {
    const tables = [...(await this.columns())].map(([name, columns]) => ({ name, columns }));
    return JSON.stringify({ tables });
  }

  async count(relation: string): Promise<number> {
    const t = await this.conn.query(`SELECT count(*) AS n FROM ${sqlIdent(relation)}`);
    return Number(t.getChildAt(0)?.get(0));
  }

  /**
   * Replace every user table and view with the result of `script`, then fill
   * empty base tables with fake rows when `fill` is set. Throws the script's
   * error after cleaning up; the tables created before the error remain.
   */
  async applyTables(script: string, fill: boolean, seed: number): Promise<void> {
    const existing = await this.relations();
    for (const r of existing.filter((x) => x.isView)) await this.conn.query(`DROP VIEW IF EXISTS ${sqlIdent(r.name)}`);
    for (const r of existing.filter((x) => !x.isView)) await this.conn.query(`DROP TABLE IF EXISTS ${sqlIdent(r.name)} CASCADE`);

    if (script.trim() !== '') await this.conn.query(script);
    if (!fill) return;

    const columns = await this.columns();
    for (const r of await this.relations()) {
      if (r.isView || (await this.count(r.name)) > 0) continue;
      const insert = fakeInsert(r.name, columns.get(r.name) ?? [], seed);
      if (insert !== '') await this.conn.query(insert);
    }
  }

  /**
   * Row count of each top-level CTE in a serialized SELECT. Each count query is
   * built as an AST (template `SELECT count(*) FROM __cte__` + the original
   * cte_map) and turned back into SQL by DuckDB, never by string concatenation.
   */
  async cteCounts(astJson: string): Promise<CteCount[]> {
    const ast = JSON.parse(astJson) as SerializedSql;
    const cteMap = ast.statements[0]?.node.cte_map;
    if (cteMap === undefined) return [];
    const out: CteCount[] = [];
    for (const { key } of cteMap.map) {
      const stmt = structuredClone(this.countTemplate);
      const node = stmt.statements[0]!.node;
      node.cte_map = cteMap;
      node.from_table.table_name = key;
      try {
        const sqlTable = await this.conn.query(`SELECT json_deserialize_sql(${sqlString(JSON.stringify(stmt))}) AS s`);
        const sql = String(sqlTable.getChildAt(0)?.get(0));
        const t = await this.conn.query(sql);
        out.push({ name: key, count: Number(t.getChildAt(0)?.get(0)) });
      } catch (e) {
        out.push({ name: key, error: errorMessage(e) });
      }
    }
    return out;
  }
}

async function serializeWith(conn: duckdb.AsyncDuckDBConnection, sql: string): Promise<string> {
  const t = await conn.query(`SELECT json_serialize_sql(${sqlString(sql)}) AS j`);
  return String(t.getChildAt(0)?.get(0));
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
