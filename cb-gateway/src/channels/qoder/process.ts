import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { CLI_ROOT, CLI_CONFIG_DIR, ensureCli, isCliLoggedIn } from './cli.ts';

const PAYLOAD_PATH = path.join(CLI_ROOT, 'sdk-payload.json');

const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 90 * 1000;
const CONTROL_TIMEOUT_MS = 20 * 1000;
const IDLE_RELEASE_MS = (() => {
  const raw = process.env.QODER_IDLE_RELEASE_MS;
  if (raw === undefined || raw.trim() === '') return 10 * 60 * 1000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 10 * 60 * 1000;
  return value;
})();

let logSink: any = null;
export function setProcessLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[qoder-process] ${args.join(' ')}`);
}

export interface CliEvent {
  type: string;
  subtype?: string;
  [key: string]: any;
}

export interface TurnCallbacks {
  onEvent(event: CliEvent): void;
  end(error?: Error): void;
}

interface QueueItem {
  payload: any;
  callbacks: TurnCallbacks;
}

interface PendingControl {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class CliSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private starting: Promise<void> | null = null;
  private queue: QueueItem[] = [];
  private current: QueueItem | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private buffer = '';
  private turnTimer: NodeJS.Timeout | null = null;
  private handshake: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private pending = new Map<string, PendingControl>();
  private controlSeq = 0;
  private currentModel = 'auto';
  private creditsBaseline = 0;

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  private async ensureStarted(): Promise<void> {
    if (this.isRunning && this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async doStart(): Promise<void> {
    const entry = await ensureCli();
    if (!isCliLoggedIn()) {
      throw new Error('Qoder CLI 未登录，请先在面板点「登录」完成设备码授权');
    }
    fs.mkdirSync(CLI_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(PAYLOAD_PATH, JSON.stringify({ type: 'qodercli' }), 'utf8');

    log(`启动 CLI 进程 entry=${path.basename(entry)}`);
    const child = spawn(
      process.execPath,
      [
        entry,
        '-p',
        '--input-format',
        'stream-json',
        '-o',
        'stream-json',
        '--include-partial-messages',
        '--tools=',
      ],
      {
        env: {
          ...process.env,
          QODERCN_PERSONAL_ACCESS_TOKEN: '',
          QODERCN_CONFIG_DIR: CLI_CONFIG_DIR,
          QODER_AGENT_SDK_ENTRYPOINT: '1',
          QODER_SDK_AUTH_PAYLOAD_FILE: PAYLOAD_PATH,
        },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    this.buffer = '';
    this.ready = false;
    this.creditsBaseline = 0;
    this.currentModel = 'auto';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (!text) return;
      log(`stderr: ${text.slice(0, 400)}`);
    });
    child.on('error', (error) => {
      log(`进程错误：${error.message}`);
      this.failAll(error);
    });
    child.on('exit', (code, signal) => {
      log(`进程退出 code=${code} signal=${signal}`);
      this.child = null;
      this.ready = false;
      this.failAll(new Error(`Qoder CLI 进程意外退出（code=${code}）`));
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshake = null;
        reject(new Error('Qoder CLI 握手超时'));
      }, HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
      this.handshake = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.write({
        type: 'control_request',
        request_id: 'init-1',
        request: {
          subtype: 'initialize',
          capabilities: ['multi_session_v2'],
          model: 'auto',
          business: { product: 'qoder' },
        },
      });
    });

    this.ready = true;
    log('CLI 握手完成');
  }

  private write(value: any) {
    if (!this.child || this.child.exitCode !== null) return;
    try {
      this.child.stdin.write(`${JSON.stringify(value)}\n`);
    } catch (error: any) {
      log(`写 stdin 失败：${error.message}`);
    }
  }

  private onStdout(chunk: string) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let event: CliEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      this.onEvent(event);
    }
  }

  private onEvent(event: CliEvent) {
    if (event.type === 'control_response') {
      const inner: any = event.response || {};
      const requestId = typeof inner.request_id === 'string' ? inner.request_id : '';

      if (requestId === 'init-1') {
        const handshake = this.handshake;
        this.handshake = null;
        if (!handshake) return;
        if (inner.subtype === 'error') {
          handshake.reject(new Error(`Qoder CLI 握手失败：${inner.error || 'initialize 失败'}`));
        } else {
          handshake.resolve();
        }
        return;
      }

      const pending = this.pending.get(requestId);
      if (pending) {
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        if (inner.subtype === 'error') {
          pending.reject(new Error(inner.error || 'control 请求失败'));
        } else {
          pending.resolve(inner.response ?? {});
        }
      }
      return;
    }

    if (event.type === 'result') {
      const current = this.current;
      if (!current) return;
      this.current = null;
      if (this.turnTimer) {
        clearTimeout(this.turnTimer);
        this.turnTimer = null;
      }
      current.callbacks.onEvent(event);
      const failed = event.is_error === true || (event.subtype && event.subtype !== 'success');
      current.callbacks.end(failed ? new Error(this.describeFailure(event)) : undefined);
      this.scheduleIdle();
      this.drain();
      return;
    }

    if (this.current) this.current.callbacks.onEvent(event);
  }

  private describeFailure(event: CliEvent): string {
    const errors = Array.isArray(event.errors) ? event.errors.join('; ') : '';
    if (errors) return `Qoder CLI 报错：${errors}`;
    if (event.terminal_reason === 'auth_payload_missing') {
      return 'Qoder CLI 缺少凭据，先执行 CLI 的 login';
    }
    if (event.terminal_reason === 'initialize_required') {
      return 'Qoder CLI 握手未完成，正在重建进程';
    }
    return `Qoder CLI 返回 ${event.subtype || 'error'}`;
  }

  private control(request: Record<string, any>): Promise<any> {
    const requestId = `ctl-${++this.controlSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Qoder 控制请求超时：${request.subtype}`));
      }, CONTROL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      this.write({ type: 'control_request', request_id: requestId, request });
    });
  }

  async setModel(model: string): Promise<void> {
    if (model === this.currentModel) return;
    await this.ensureStarted();
    await this.control({ subtype: 'set_model', model });
    this.currentModel = model;
    log(`模型切换到 ${model}`);
  }

  turnCredits(event: CliEvent): number {
    const total = Number(event.total_credits);
    if (!Number.isFinite(total)) return 0;
    const delta = total - this.creditsBaseline;
    this.creditsBaseline = total;
    return delta > 0 ? delta : 0;
  }

  async submit(payload: any, callbacks: TurnCallbacks): Promise<void> {
    this.clearIdle();
    this.queue.push({ payload, callbacks });
    try {
      await this.ensureStarted();
    } catch (error: any) {
      this.failAll(error);
      return;
    }
    this.drain();
  }

  private drain() {
    if (this.current || this.queue.length === 0) return;
    if (!this.ready || !this.isRunning) return;
    const item = this.queue.shift()!;
    this.current = item;
    this.turnTimer = setTimeout(() => {
      const current = this.current;
      this.current = null;
      this.turnTimer = null;
      if (current) current.callbacks.end(new Error(`Qoder 对话超时（${TURN_TIMEOUT_MS / 1000}s）`));
      this.restart();
    }, TURN_TIMEOUT_MS);
    this.turnTimer.unref?.();
    this.write(item.payload);
  }

  private failAll(error: Error) {
    const handshake = this.handshake;
    this.handshake = null;
    if (handshake) handshake.reject(error);

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();

    const current = this.current;
    this.current = null;
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    if (current) current.callbacks.end(error);

    const pendingQueue = this.queue;
    this.queue = [];
    for (const item of pendingQueue) item.callbacks.end(error);
  }

  private clearIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdle() {
    this.clearIdle();
    if (IDLE_RELEASE_MS <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.current || this.queue.length > 0) return;
      log(`闲置 ${IDLE_RELEASE_MS / 1000}s，释放 CLI 进程`);
      this.stop();
    }, IDLE_RELEASE_MS);
    this.idleTimer.unref?.();
  }

  stop() {
    this.clearIdle();
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.creditsBaseline = 0;
    if (!child || child.exitCode !== null) return;
    try {
      child.stdin.end();
    } catch {
    }
    try {
      child.kill();
    } catch (error: any) {
      log(`kill 失败：${error.message}`);
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
        }
      }
    }, 5000);
    timer.unref?.();
  }

  restart() {
    log('重建 CLI 进程');
    this.stop();
  }
}

const session = new CliSession();

export interface TurnOptions {
  model?: string;
  keepContext?: boolean;
}

export async function runTurn(
  prompt: string,
  options: TurnOptions,
  onEvent: (event: CliEvent) => void,
): Promise<{ result: CliEvent; credits: number }> {
  if (options.model) {
    try {
      await session.setModel(options.model);
    } catch (error: any) {
      log(`切换模型 ${options.model} 失败，沿用当前模型：${error.message}`);
    }
  }

  return new Promise((resolve, reject) => {
    let result: CliEvent | null = null;
    session
      .submit(
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: prompt }] },
        },
        {
          onEvent(event) {
            if (event.type === 'result') result = event;
            onEvent(event);
          },
          end(error) {
            if (error) {
              reject(error);
              return;
            }
            const final = result || { type: 'result', subtype: 'success' };
            resolve({ result: final, credits: session.turnCredits(final) });
          },
        },
      )
      .catch(reject);
  });
}

export function shutdown() {
  session.stop();
}

export { CliSession };
