// Print DuckDB's json_serialize_sql parse tree for a SQL string (dev aid).
import { openDuck, serialize } from './duck.mjs';

const conn = await openDuck();
console.log(JSON.stringify(JSON.parse(serialize(conn, process.argv[2])), null, 1));
