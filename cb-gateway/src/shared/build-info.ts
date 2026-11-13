import fs from 'node:fs';

export const PACKAGE_VERSION: string | null = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || null;
  } catch {
    return null;
  }
})();

export const STARTED_AT_MS = Date.now() - Math.round(process.uptime() * 1000);

export const STARTED_AT_ISO = new Date(STARTED_AT_MS).toISOString();
