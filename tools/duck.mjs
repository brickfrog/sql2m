// Node-side DuckDB-WASM (same engine build as the page) for tests and fixture work.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const dist = path.dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));
const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/public/duckdb-extensions');

// The blocking Node bundle fetches extensions with synchronous HTTP from the
// main thread, so it can load neither a file path nor from an in-process
// server. Serve the page's self-hosted json extension from a loopback child
// process instead; nothing is fetched from extensions.duckdb.org.
const SERVER = `
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const root = process.argv[1];
const srv = http.createServer((req, res) => {
  const f = path.join(root, path.normalize(decodeURIComponent(req.url.split('?')[0])));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => { if (err) { res.writeHead(404); res.end(); } else { res.writeHead(200); res.end(buf); } });
});
srv.listen(0, '127.0.0.1', () => process.stdout.write(srv.address().port + '\\n'));
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`;

async function extensionRepo() {
  const child = spawn(process.execPath, ['-e', SERVER, extDir], { stdio: ['pipe', 'pipe', 'inherit'] });
  process.on('exit', () => child.kill());
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (d) => resolve(String(d).trim()));
  });
  // Don't keep the parent alive for the server's sake.
  child.unref();
  child.stdout.unref?.();
  child.stdin.unref?.();
  return `http://127.0.0.1:${port}`;
}

export async function openDuck() {
  const bundles = {
    mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: path.join(dist, 'duckdb-node-mvp.worker.cjs') },
    eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: path.join(dist, 'duckdb-node-eh.worker.cjs') },
  };
  const logger = new duckdb.VoidLogger();
  const db = await duckdb.createDuckDB(bundles, logger, duckdb.NODE_RUNTIME);
  await db.instantiate(() => {});
  const conn = db.connect();
  const repo = await extensionRepo();
  conn.query(`SET autoinstall_known_extensions=false; SET autoload_known_extensions=false; SET custom_extension_repository='${repo}'`);
  conn.query('LOAD json');
  return conn;
}

/** Rows of an arrow result as plain objects (BigInt → Number when safe). */
export function rows(table) {
  return table.toArray().map((r) => {
    const o = {};
    for (const f of table.schema.fields) {
      let v = r[f.name];
      if (typeof v === 'bigint') v = Number(v);
      o[f.name] = v;
    }
    return o;
  });
}

export function serialize(conn, sql) {
  const quoted = "'" + sql.replaceAll("'", "''") + "'";
  const res = conn.query(`SELECT json_serialize_sql(${quoted}) AS j`);
  return rows(res)[0].j;
}

/** Transpiler catalog JSON for every table in the main schema. */
export function catalog(conn) {
  const cols = rows(conn.query(
    "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='main' ORDER BY table_name, ordinal_position",
  ));
  const tables = new Map();
  for (const c of cols) {
    if (!tables.has(c.table_name)) tables.set(c.table_name, []);
    tables.get(c.table_name).push({ name: c.column_name, type: c.data_type });
  }
  return { tables: [...tables].map(([name, columns]) => ({ name, columns })) };
}
