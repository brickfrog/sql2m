// Dev aid: node tools/m.mjs "<CREATE TABLE ...;>" "<SELECT ...>" → prints the M.
import { catalog, openDuck, serialize } from './duck.mjs';
import { transpile } from '../web/src/generated/sql2m.js';

const [ddl, query] = process.argv.slice(2);
const conn = await openDuck();
conn.query(ddl);
const res = JSON.parse(transpile(serialize(conn, query), JSON.stringify(catalog(conn))));
if (res.ok) {
  console.log(res.m);
  for (const w of res.warnings) console.log('warning:', w);
} else {
  console.log('REFUSED:', res.error);
}
