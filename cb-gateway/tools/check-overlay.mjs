import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const OVERLAY = process.argv[2] ??
  path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');

let yaml = null;
for (const id of ['js-yaml', 'yaml']) {
  try {
    yaml = require(id);
    break;
  } catch {
  }
}

const text = readFileSync(OVERLAY, 'utf8');

if (yaml && typeof yaml.loadAll === 'function') {
  try {
    const docs = yaml.loadAll(text);
    let items = 0;
    for (const doc of docs) if (Array.isArray(doc)) items += doc.length;
    console.log(`${OVERLAY}: OK (${docs.length} document(s), ${items} patch item(s))`);
    process.exit(0);
  } catch (error) {
    console.error(`${OVERLAY}: FAILED — ${error.message}`);
    const line = error.mark?.line;
    if (typeof line === 'number') {
      const lines = text.split(/\r?\n/);
      for (let i = Math.max(0, line - 2); i <= Math.min(lines.length - 1, line + 2); i++) {
        console.error(`${String(i + 1).padStart(4)} | ${lines[i]}`);
      }
    }
    process.exit(1);
  }
}

const lines = text.split(/\r?\n/);
let seenItem = false;
let problems = 0;
let lastItemLine = 0;

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
  const indent = raw.length - raw.trimStart().length;

  if (raw.startsWith('- ')) {
    seenItem = true;
    lastItemLine = i + 1;
    continue;
  }

  if (!seenItem) {
    console.error(`${String(i + 1).padStart(4)} | ${raw}`);
    console.error('  ^ content before the first sequence item');
    problems++;
    continue;
  }

  if (indent === 0) {
    console.error(`${String(i + 1).padStart(4)} | ${raw}`);
    console.error(`  ^ column 0 inside the item starting at line ${lastItemLine}`);
    problems++;
  }
}

if (problems > 0) {
  console.error(`${OVERLAY}: FAILED — ${problems} indentation problem(s) ` +
    '(js-yaml was not resolvable, so this is the structural check only)');
  process.exit(1);
}

console.log(`${OVERLAY}: structurally OK ` +
  '(js-yaml was not resolvable, so this is the structural check only)');
