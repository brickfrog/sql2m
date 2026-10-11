import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// Exercise the browser's actual orchestration with controlled async updates.
// DuckDB and the DOM rendering pipeline are outside this regression's scope.
const main = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
const start = main.indexOf('let running = false;');
const end = main.indexOf('\nlet timer:', start);
assert.ok(start >= 0 && end > start, 'refresh orchestration exists');
const source = stripTypeScriptTypes(main.slice(start, end));

function harness(update) {
  const ui = { status: { textContent: 'DuckDB ready' } };
  const refresh = new Function('update', 'ui', 'errorMessage', `${source}\nreturn refresh;`)(
    update, ui, (error) => error.message,
  );
  return { refresh, status: ui.status };
}

test('rapid edits during a failing refresh run the latest queued update', async () => {
  const first = Promise.withResolvers();
  const seen = [];
  let query = 'original';
  const { refresh, status } = harness(async () => {
    seen.push(query);
    if (seen.length === 1) await first.promise;
  });
  const active = refresh();
  query = 'intermediate edit';
  await refresh();
  query = 'latest edit';
  await refresh();
  first.reject(new Error('synthetic worker failure'));
  await active;
  assert.deepEqual(seen, ['original', 'latest edit']);
  assert.equal(status.textContent, 'DuckDB ready');
});

test('a later successful refresh clears the unexpected error status', async () => {
  let fail = true;
  const { refresh, status } = harness(async () => {
    if (fail) throw new Error('synthetic worker failure');
  });
  await refresh();
  assert.equal(status.textContent, 'Unexpected error: synthetic worker failure');
  fail = false;
  await refresh();
  assert.equal(status.textContent, 'DuckDB ready');
});

test('persistent failure drains queued edits once and releases the running guard', async () => {
  const first = Promise.withResolvers();
  let calls = 0;
  const { refresh, status } = harness(async () => {
    calls++;
    if (calls === 1) await first.promise;
    throw new Error('still failing');
  });
  const active = refresh();
  await refresh();
  await refresh();
  first.resolve();
  await active;
  assert.equal(calls, 2);
  assert.equal(status.textContent, 'Unexpected error: still failing');
  await refresh();
  assert.equal(calls, 3);
});

test('successful updates remain serialized and coalesce rapid edits', async () => {
  const first = Promise.withResolvers();
  let calls = 0;
  let activeUpdates = 0;
  let maxActive = 0;
  const { refresh } = harness(async () => {
    calls++;
    maxActive = Math.max(maxActive, ++activeUpdates);
    if (calls === 1) await first.promise;
    activeUpdates--;
  });
  const active = refresh();
  await refresh();
  await refresh();
  first.resolve();
  await active;
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  await refresh();
  assert.equal(calls, 3);
});
