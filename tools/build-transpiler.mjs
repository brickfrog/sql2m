// Build the MoonBit transpiler for the JS backend and copy the ESM module
// where both the web app and the Node tests import it from.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync('moon', ['build', '--target', 'js', '--release'], { cwd: root, stdio: 'inherit' });
const out = path.join(root, 'web', 'src', 'generated');
mkdirSync(out, { recursive: true });
copyFileSync(path.join(root, '_build/js/release/build/js/js.js'), path.join(out, 'sql2m.js'));
copyFileSync(path.join(root, '_build/js/release/build/js/js.d.ts'), path.join(out, 'sql2m.d.ts'));
copyFileSync(path.join(root, '_build/js/release/build/js/moonbit.d.ts'), path.join(out, 'moonbit.d.ts'));
