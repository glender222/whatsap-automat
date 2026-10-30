import 'dotenv/config';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import config from '../src/config/index';

const PORT = String(config.server.port);
const BACKEND_URL = `http://localhost:${PORT}`;
const CALLBACK_PATH = '/api/webhooks/meta/whatsapp';
const OUTPUT_FILE = path.join(process.cwd(), '.cloudflare-webhook-url.txt');
const CLOUDFLARED_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const SHUTDOWN_GRACE_MS = 3000;
const LOCAL_CLOUDFLARED_PATH = path.join(
  process.cwd(),
  '.tools',
  'cloudflared',
  process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared',
);
const managedChildren: ChildProcess[] = [];
let stopping = false;

function resolveCloudflaredCommand(): string {
  const configuredPath = String(process.env.CLOUDFLARED_BIN || '').trim();
  if (configuredPath) return configuredPath;
  return fs.existsSync(LOCAL_CLOUDFLARED_PATH) ? LOCAL_CLOUDFLARED_PATH : 'cloudflared';
}

function startBackend(): ChildProcess {
  const child = spawn('npm', ['run', 'dev'], {
    cwd: process.cwd(),
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  child.stdout?.resume();
  child.stderr?.resume();
  child.on('error', () => {
    console.error('No se pudo iniciar el backend.');
  });
    child.once('exit', (code) => {
      if (!stopping) {
        console.error(`El backend termino inesperadamente (${code ?? 'sin codigo'}).`);
        void shutdown(1);
      }
  });
  return child;
}

function startCloudflaredTunnel(): { child: ChildProcess; publicUrl: Promise<string> } {
  let settled = false;
  let outputBuffer = '';
  let timeout: NodeJS.Timeout;

  const command = resolveCloudflaredCommand();
  const child = spawn(command, ['tunnel', '--url', BACKEND_URL], {
    cwd: process.cwd(),
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const publicUrl = new Promise<string>((resolve, reject) => {
    const finish = (error: Error | null, url?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(String(url));
    };

    const inspectOutput = (chunk: Buffer | string): void => {
      outputBuffer = `${outputBuffer}${String(chunk)}`.slice(-65536);
      const match = outputBuffer.match(CLOUDFLARED_URL_PATTERN);
      if (match) finish(null, match[0]);
    };

    child.stdout?.on('data', inspectOutput);
    child.stderr?.on('data', inspectOutput);
    child.once('error', () => finish(new Error('No se pudo iniciar cloudflared.')));
    child.once('exit', (code) => {
      if (!settled) {
        finish(new Error(`cloudflared termino antes de publicar la URL (${code ?? 'sin codigo'}).`));
      } else if (!stopping) {
        console.error(`Cloudflare Tunnel termino inesperadamente (${code ?? 'sin codigo'}).`);
        void shutdown(1);
      }
    });

    timeout = setTimeout(() => {
      finish(new Error('Cloudflare Tunnel no publico una URL dentro de 45 segundos.'));
    }, 45000);
  });

  return { child, publicUrl };
}

async function isBackendReady(): Promise<boolean> {
  try {
    const response = await fetch(`${BACKEND_URL}/health`);
    if (!response.ok) return false;
    return isExpectedBackendHealth(await response.json());
  } catch {
    return false;
  }
}

export function isExpectedBackendHealth(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const health = payload as { status?: unknown; provider?: unknown; metaConfigured?: unknown };
  return health.status === 'ok'
    && health.provider === 'meta-cloud'
    && health.metaConfigured === true;
}

async function waitForBackend(maxAttempts = 40): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (await isBackendReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`El backend no esta listo en ${BACKEND_URL}.`);
}

function stop(children: ChildProcess[], signal: NodeJS.Signals): void {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      child.kill(signal);
    }
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function shutdown(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  stop(managedChildren, 'SIGTERM');
  await Promise.race([
    Promise.all(managedChildren.map(waitForExit)),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
  ]);
  if (process.platform !== 'win32') stop(managedChildren, 'SIGKILL');
  process.exit(exitCode);
}

function writeRuntimeOutput(content: string): void {
  fs.writeFileSync(OUTPUT_FILE, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(OUTPUT_FILE, 0o600);
}

export function buildRuntimeOutput(publicUrl: string, callbackUrl: string): string {
  return [`PUBLIC_URL=${publicUrl}`, `META_CALLBACK_URL=${callbackUrl}`, ''].join('\n');
}

export function buildSuccessOutput(
  backendAlreadyRunning: boolean,
  publicUrl: string,
  callbackUrl: string,
): string[] {
  return [
    `Backend: listo (${backendAlreadyRunning ? 'reutilizado' : 'iniciado'})`,
    `Public URL: ${publicUrl}`,
    `Callback URL: ${callbackUrl}`,
  ];
}

async function main(): Promise<void> {
  if (config.whatsapp.provider !== 'meta-cloud') {
    throw new Error('dev:tunnel requiere WHATSAPP_PROVIDER=meta-cloud');
  }

  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));

  writeRuntimeOutput('');

  const backendAlreadyRunning = await isBackendReady();
  if (!backendAlreadyRunning) {
    managedChildren.push(startBackend());
  }
  await waitForBackend();

  const tunnel = startCloudflaredTunnel();
  managedChildren.push(tunnel.child);
  const publicUrl = await tunnel.publicUrl;
  const callbackUrl = `${publicUrl}${CALLBACK_PATH}`;

  writeRuntimeOutput(buildRuntimeOutput(publicUrl, callbackUrl));

  for (const line of buildSuccessOutput(backendAlreadyRunning, publicUrl, callbackUrl)) {
    console.log(line);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'No se pudo iniciar el entorno con tunel.');
    void shutdown(1);
  });
}
