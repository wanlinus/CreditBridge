import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFileSync, spawn } from 'node:child_process';

import { DATA_DIR } from '../../shared/paths.ts';

export const CLI_ROOT = path.join(DATA_DIR, 'cli', 'qoder');
export const CLI_DIR = path.join(CLI_ROOT, 'qoder-worker-runtime');
export const CLI_ENTRY = path.join(CLI_DIR, 'qoder-worker-runtime.obf.mjs');
const MANIFEST_REL = path.join(
  'node_modules',
  '@qoder-ai',
  'qoder-cn-agent-sdk',
  'dist',
  'runtime-manifest.json',
);

export const QODER_CLI_VERSION = '1.1.79-hotfix.19';

const CLIENT_DIRS = ['com.qodercn.app.stable', 'com.qoder.app.stable'];

function targetName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  return `${process.platform}-${arch}`;
}

let logSink: any = null;
export function setCliLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[qoder-cli] ${args.join(' ')}`);
}

interface RuntimeManifest {
  version: string;
  url: string;
  source: string;
}

export function resolveManifest(): RuntimeManifest {
  const appData = process.env.APPDATA;
  if (appData) {
    for (const dir of CLIENT_DIRS) {
      const file = path.join(appData, dir, MANIFEST_REL);
      if (!fs.existsSync(file)) continue;
      try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        const version = doc.qoderCliVersion;
        const template = doc.workerRuntime && doc.workerRuntime.urlTemplate;
        if (typeof version === 'string' && version !== '' && typeof template === 'string') {
          return {
            version,
            url: template.replace('{target}', targetName()),
            source: `client:${dir}`,
          };
        }
      } catch (error: any) {
        log(`读 ${dir} 的 runtime-manifest.json 失败：${error.message}`);
      }
    }
  }
  return {
    version: QODER_CLI_VERSION,
    url: `https://static.qoder.com.cn/qoder-cli-cn/dev/releases/${QODER_CLI_VERSION}/qoderclicn-worker-runtime-${targetName()}.tgz`,
    source: 'fallback',
  };
}

function installedVersion(): string | undefined {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(CLI_DIR, 'runtime-info.json'), 'utf8'));
    return typeof doc.version === 'string' ? doc.version : undefined;
  } catch {
    return undefined;
  }
}

export function isInstalled(): boolean {
  return fs.existsSync(CLI_ENTRY);
}

async function download(url: string, dest: string) {
  log(`下载 ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`下载失败 HTTP ${response.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(response.body as any, fs.createWriteStream(dest));
  const size = fs.statSync(dest).size;
  if (size < 1024 * 1024) {
    throw new Error(`下载文件过小（${size} 字节），可能拿到了错误页`);
  }
  log(`下载完成 ${size} 字节`);
  return size;
}

function extract(archive: string) {
  fs.mkdirSync(CLI_ROOT, { recursive: true });
  log(`解包到 ${CLI_ROOT}`);
  const tarBin = process.platform === 'win32' ? 'tar.exe' : 'tar';
  execFileSync(tarBin, ['-xzf', archive, '-C', CLI_ROOT], {
    stdio: 'ignore',
    timeout: 5 * 60 * 1000,
  });
}

let ensuring: Promise<string> | null = null;

export async function ensureCli(options: { force?: boolean } = {}): Promise<string> {
  if (!options.force && isInstalled()) {
    const manifest = resolveManifest();
    const have = installedVersion();
    if (!have || have === manifest.version) return CLI_ENTRY;
    log(`已装版本 ${have}，客户端要求 ${manifest.version}；继续使用已装版本`);
    return CLI_ENTRY;
  }
  if (ensuring) return ensuring;
  ensuring = (async () => {
    const manifest = resolveManifest();
    const archive = path.join(CLI_ROOT, 'cli.tgz');
    try {
      fs.rmSync(CLI_DIR, { recursive: true, force: true });
      await download(manifest.url, archive);
      extract(archive);
      if (!fs.existsSync(CLI_ENTRY)) {
        throw new Error(`解包后没有找到 ${CLI_ENTRY}`);
      }
      const have = installedVersion();
      if (have && have !== manifest.version) {
        throw new Error(`解包后版本不符：期望 ${manifest.version}，实际 ${have}`);
      }
      log(`CLI 就位 version=${have || manifest.version} source=${manifest.source}`);
      return CLI_ENTRY;
    } finally {
      ensuring = null;
      try {
        fs.rmSync(archive, { force: true });
      } catch {
      }
    }
  })();
  return ensuring;
}

export const CLI_CONFIG_DIR = path.join(CLI_ROOT, 'config');

const CLI_AUTH_USER = path.join(CLI_CONFIG_DIR, '.auth', 'user');
const CLI_AUTH_MACHINE = path.join(CLI_CONFIG_DIR, '.auth', 'machine_id');

export function isCliLoggedIn(): boolean {
  return fs.existsSync(CLI_AUTH_USER) && fs.existsSync(CLI_AUTH_MACHINE);
}

export async function loginCli(options?: { onUrl?: (url: string) => void; signal?: AbortSignal }): Promise<void> {
  const entry = await ensureCli();
  fs.mkdirSync(CLI_CONFIG_DIR, { recursive: true });

  log(`启动 CLI 登录进程`);

  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [entry, 'login'],
      {
        env: {
          ...process.env,
          QODERCN_PERSONAL_ACCESS_TOKEN: '',
          QODERCN_CONFIG_DIR: CLI_CONFIG_DIR,
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let buffer = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
      }
      fn();
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const match = buffer.match(/https:\/\/qoder\.cn\/device\/[^\s"']+/u);
      if (match && options?.onUrl) {
        options.onUrl(match[0]);
        options.onUrl = undefined;
      }
      if (/Login successful/u.test(buffer)) {
        finish(() => {
          setTimeout(() => resolve(), 500);
        });
        return;
      }
      if (/Login failed/u.test(buffer) || /Login timed out/u.test(buffer) || /cancelled/u.test(buffer)) {
        finish(() => reject(new Error(buffer.slice(-300).trim() || 'CLI 登录失败')));
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (error) => finish(() => reject(error)));
    child.on('exit', (code) => {
      if (!settled) {
        if (code === 0 && isCliLoggedIn()) {
          finish(() => resolve());
        } else {
          finish(() => reject(new Error(`CLI 登录进程退出 code=${code}`)));
        }
      }
    });

    const timer = setTimeout(() => {
      finish(() => reject(new Error('CLI 登录超时（5 分钟）')));
    }, 5 * 60 * 1000);
    timer.unref?.();

    if (options?.signal) {
      if (options.signal.aborted) {
        finish(() => reject(new Error('登录已取消')));
        return;
      }
      options.signal.addEventListener(
        'abort',
        () => finish(() => reject(new Error('登录已取消'))),
        { once: true },
      );
    }
  });
}

