import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './shared/paths.ts';
import { localDate } from './shared/clock.ts';

const RETENTION_DAYS = 30;

let verbose = true;

export function configureLogger(options: { verbose?: boolean } = {}) {
  if (typeof options.verbose === 'boolean') verbose = options.verbose;
}

function pruneOldLogs() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  let names;
  try {
    names = fs.readdirSync(LOG_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^gateway-\d{4}-\d{2}-\d{2}\.log$/u.test(name)) continue;
    const file = path.join(LOG_DIR, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
        if (verbose) console.log(`[logger] 清理过期日志 ${name}`);
      }
    } catch {
    }
  }
}

pruneOldLogs();

export function log(...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  if (verbose) console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const day = localDate();
    fs.appendFileSync(path.join(LOG_DIR, `gateway-${day}.log`), line + '\n');
  } catch {
  }
}
