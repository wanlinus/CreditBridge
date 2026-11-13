import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.QB_DATA_DIR
  ? path.resolve(process.env.QB_DATA_DIR)
  : path.join(__dirname, '..', '..', 'data');
export const AUTH_DIR = path.join(DATA_DIR, 'auth');
export const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
export const STATE_DIR = path.join(DATA_DIR, 'state');
export const CHECKIN_DIR = path.join(STATE_DIR, 'checkin');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
