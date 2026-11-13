import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AUTH_DIR } from '../shared/paths.ts';
import { writeFileAtomic } from '../shared/atomic-write.ts';

const KEYS_PATH = path.join(AUTH_DIR, 'keys.json');

const PREFIX = 'sk-';
const SECRET_BODY_LEN = 48;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const VISIBLE_PREFIX_LEN = 12;
const SALT_BYTES = 16;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const SECRET_BYTES_OUT = 32;
const VERIFY_CACHE_TTL_MS = 5 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface ApiKeyRecord {
  id: string;
  label: string;
  secret?: string;
  salt?: string;
  hash?: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  enabled: boolean;
  accountScope: string[] | null;
}

export interface ApiKeyPublic {
  id: string;
  label: string;
  secret: string | null;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  enabled: boolean;
  accountScope: string[] | null;
}

interface KeysDoc {
  keys: ApiKeyRecord[];
}

let cache: ApiKeyRecord[] | null = null;
const verifyCache = new Map<string, { record: ApiKeyRecord; at: number }>();
const lastTouched = new Map<string, number>();

function publicOf(record: ApiKeyRecord): ApiKeyPublic {
  return {
    id: record.id,
    label: record.label,
    secret: typeof record.secret === 'string' && record.secret !== '' ? record.secret : null,
    prefix: record.prefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    enabled: record.enabled,
    accountScope: record.accountScope,
  };
}

function readDoc(): KeysDoc {
  try {
    const doc = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
    if (doc && Array.isArray(doc.keys)) {
      return {
        keys: doc.keys.filter(
          (item: any) =>
            item &&
            typeof item.id === 'string' &&
            ((typeof item.secret === 'string' && item.secret !== '') ||
              (typeof item.hash === 'string' && typeof item.salt === 'string')),
        ),
      };
    }
  } catch {
  }
  return { keys: [] };
}

function writeDoc(doc: KeysDoc): void {
  writeFileAtomic(KEYS_PATH, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(KEYS_PATH, 0o600);
  } catch {
  }
  cache = doc.keys;
}

function records(): ApiKeyRecord[] {
  if (!cache) cache = readDoc().keys;
  return cache;
}

function digest(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function randomBody(length: number): string {
  const out: string[] = [];
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      if (byte >= 248) continue;
      out.push(ALPHABET[byte % 62]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

function hashSecret(secret: string, saltHex: string): Buffer {
  return crypto.scryptSync(secret, Buffer.from(saltHex, 'hex'), SECRET_BYTES_OUT, SCRYPT);
}

export function listKeys(): ApiKeyPublic[] {
  return [...records()].sort((a, b) => a.createdAt - b.createdAt).map(publicOf);
}

export function hasAnyCredential(): boolean {
  return records().some((record) => record.enabled);
}

export function createKey(label: string): { record: ApiKeyPublic; secret: string } {
  const secret = PREFIX + randomBody(SECRET_BODY_LEN);
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const record: ApiKeyRecord = {
    id: `k_${crypto.randomBytes(4).toString('hex')}`,
    label: label.trim() === '' ? '未命名' : label.trim().slice(0, 60),
    secret,
    salt,
    hash: hashSecret(secret, salt).toString('hex'),
    prefix: secret.slice(0, VISIBLE_PREFIX_LEN),
    createdAt: Date.now(),
    lastUsedAt: null,
    enabled: true,
    accountScope: null,
  };
  const doc = readDoc();
  doc.keys.push(record);
  writeDoc(doc);
  return { record: publicOf(record), secret };
}

export function updateKey(id: string, patch: { label?: string; enabled?: boolean }): ApiKeyPublic | undefined {
  const doc = readDoc();
  const record = doc.keys.find((item) => item.id === id);
  if (!record) return undefined;
  if (typeof patch.label === 'string' && patch.label.trim() !== '') record.label = patch.label.trim().slice(0, 60);
  if (typeof patch.enabled === 'boolean') record.enabled = patch.enabled;
  writeDoc(doc);
  verifyCache.clear();
  return publicOf(record);
}

export function deleteKey(id: string): boolean {
  const doc = readDoc();
  const index = doc.keys.findIndex((item) => item.id === id);
  if (index < 0) return false;
  doc.keys.splice(index, 1);
  writeDoc(doc);
  verifyCache.clear();
  return true;
}

export function verifyKey(secret: string): ApiKeyRecord | null {
  if (typeof secret !== 'string' || !secret.startsWith(PREFIX)) return null;

  const cached = verifyCache.get(digest(secret));
  if (cached && Date.now() - cached.at < VERIFY_CACHE_TTL_MS && cached.record.enabled) {
    touch(cached.record.id);
    return cached.record;
  }

  const candidatePrefix = secret.slice(0, VISIBLE_PREFIX_LEN);
  const given = Buffer.from(secret);
  for (const record of records()) {
    if (!record.enabled) continue;
    if (record.prefix !== candidatePrefix) continue;

    let matched = false;
    if (typeof record.secret === 'string' && record.secret !== '') {
      const expected = Buffer.from(record.secret);
      matched = expected.length === given.length && crypto.timingSafeEqual(expected, given);
    } else if (typeof record.hash === 'string' && typeof record.salt === 'string') {
      const expected = Buffer.from(record.hash, 'hex');
      const actual = hashSecret(secret, record.salt);
      matched = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }

    if (matched && given.length > 0) {
      verifyCache.set(digest(secret), { record, at: Date.now() });
      touch(record.id);
      return record;
    }
  }
  return null;
}

function touch(id: string): void {
  const now = Date.now();
  const previous = lastTouched.get(id) || 0;
  if (now - previous < TOUCH_INTERVAL_MS) return;
  lastTouched.set(id, now);
  const doc = readDoc();
  const record = doc.keys.find((item) => item.id === id);
  if (!record) return;
  record.lastUsedAt = now;
  writeDoc(doc);
}

export function resetKeysForTests(): void {
  cache = null;
  verifyCache.clear();
  lastTouched.clear();
}
