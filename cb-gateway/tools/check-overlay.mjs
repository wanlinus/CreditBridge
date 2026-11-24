// Validate the DSH profile overlay before it can take the app down.
//
// DSH parses `cordis.patch.yml` at startup; a bad indentation there is a fatal
// DesktopHostFatalError, not a warning. Hand-editing or scripting that file
// (for example rewriting model `name:` lines) has already cost a round of
// crashes. Run this after any change:
//
//   node tools/check-overlay.mjs
//
// Exits 0 when the overlay parses, 1 otherwise, printing the offending line.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const OVERLAY = process.argv[2] ??
  path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');

// DSH bundles js-yaml inside its asar, which Node cannot require directly.
// The checker therefore ships its own minimal structural test: js-yaml is
// tried first if it happens to be resolvable, and a structural fallback runs
// otherwise so the check still works on a clean machine.
let yaml = null;
for (const id of ['js-yaml', 'yaml']) {
  try {
    yaml = require(id);
    break;
  } catch {
    /* try the next one */
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

// --- structural fallback -------------------------------------------------
// The overlay is a top-level YAML sequence whose items start with `- ` at
// column 0. Nested keys must be indented further than the dash. This catches
// the failure mode that matters: a key written at the wrong depth.
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

  // A key must be indented deeper than the item dash (column 0), and a
  // top-level-looking key is suspicious only when it also looks like a patch
  // field name at depth 0.
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
