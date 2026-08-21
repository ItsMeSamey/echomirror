import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const ECHO_URL = new URL('https://echo360.net.au/');
const UQ_ECHO_LAUNCH_URL = new URL(
  'https://learn.uq.edu.au/webapps/blackboard/execute/blti/launchPlacement?blti_placement_id=_1088_1&content_id=_13163361_1&course_id=_206914_1&wrapped=true&from_ultra=true',
);

interface BrowserSpec {
  readonly executables: readonly string[];
  readonly dataDirectories: readonly string[];
}

interface BrowserCookie {
  readonly domain?: string;
  readonly name?: string;
  readonly value?: string;
  readonly expires?: number;
  readonly path?: string;
}

interface CdpMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();

  constructor(private readonly socket: WebSocket) {
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? 'browser command failed'));
      else pending.resolve(message.result);
    };
    socket.onclose = () => this.failPending(new Error('browser connection closed'));
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out connecting to browser cookie reader')), 5_000);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('could not connect to browser cookie reader'));
      };
    });
    return new CdpClient(socket);
  }

  send<T>(method: string, params: object = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`browser command timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function specs(): readonly BrowserSpec[] {
  const home = homedir();
  if (process.platform === 'darwin') return [
    {
      executables: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'brave-browser'],
      dataDirectories: [join(home, 'Library/Application Support/BraveSoftware/Brave-Browser')],
    },
    {
      executables: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'google-chrome'],
      dataDirectories: [join(home, 'Library/Application Support/Google/Chrome')],
    },
  ];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? '';
    return [
      {
        executables: [join(local, 'BraveSoftware/Brave-Browser/Application/brave.exe'), 'brave.exe'],
        dataDirectories: [join(local, 'BraveSoftware/Brave-Browser/User Data')],
      },
      {
        executables: [join(local, 'Google/Chrome/Application/chrome.exe'), 'chrome.exe'],
        dataDirectories: [join(local, 'Google/Chrome/User Data')],
      },
    ];
  }
  return [
    {
      executables: ['brave-browser', 'brave-browser-stable', 'brave'],
      dataDirectories: [
        join(home, '.config/BraveSoftware/Brave-Browser'),
        join(home, '.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser'),
      ],
    },
    {
      executables: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
      dataDirectories: [join(home, '.config/google-chrome'), join(home, '.config/chromium')],
    },
  ];
}

async function executable(names: readonly string[]): Promise<string | undefined> {
  const configured = process.env.ECHO_BROWSER?.trim();
  const choices = configured ? [configured] : names;
  for (const name of choices) {
    const candidates = name.includes('/')
      ? [name]
      : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, name));
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue through PATH.
      }
    }
  }
  return undefined;
}

async function copyIfPresent(source: string, destination: string): Promise<boolean> {
  try {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    return true;
  } catch {
    return false;
  }
}

async function copyCookieProfile(dataDirectory: string, profile: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if (!await copyIfPresent(join(dataDirectory, 'Local State'), join(destination, 'Local State'))) {
    throw new Error(`Browser profile has no Local State: ${dataDirectory}`);
  }
  const sourceProfile = join(dataDirectory, profile);
  const targetProfile = join(destination, profile);
  for (const file of ['Preferences', 'Secure Preferences']) {
    await copyIfPresent(join(sourceProfile, file), join(targetProfile, file));
  }
  let copied = false;
  for (const relative of [join('Network', 'Cookies'), 'Cookies']) {
    const source = join(sourceProfile, relative);
    const target = join(targetProfile, relative);
    if (!await copyIfPresent(source, target)) continue;
    copied = true;
    for (const suffix of ['-wal', '-shm', '-journal']) await copyIfPresent(source + suffix, target + suffix);
  }
  if (!copied) throw new Error(`Browser profile ${profile} has no cookie database`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function devToolsPort(profileDirectory: string, child: ChildProcess): Promise<number> {
  const filename = join(profileDirectory, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const port = Number((await readFile(filename, 'utf8')).split(/\r?\n/, 1)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Browser is still starting.
    }
    if (child.exitCode !== null) throw new Error(`browser cookie reader exited (${child.exitCode})`);
    await sleep(50);
  }
  throw new Error('browser cookie reader did not start');
}

function cookieHeader(cookies: readonly BrowserCookie[]): string | undefined {
  const now = Date.now() / 1000;
  const selected = cookies.filter(cookie => {
    if (typeof cookie.domain !== 'string' || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return false;
    const domain = cookie.domain.replace(/^\./, '');
    if (domain !== ECHO_URL.hostname && !ECHO_URL.hostname.endsWith(`.${domain}`)) return false;
    return !(typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires <= now);
  });
  selected.sort((left, right) => (right.path?.length ?? 1) - (left.path?.length ?? 1));
  return selected.length ? selected.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') : undefined;
}

async function readProfileCookie(browser: string, dataDirectory: string, profile: string): Promise<string | undefined> {
  const temporary = await mkdtemp(join(tmpdir(), 'echomirror-cookie-'));
  let child: ChildProcess | undefined;
  let client: CdpClient | undefined;
  try {
    await copyCookieProfile(dataDirectory, profile, temporary);
    const args = [
      '--headless=new', `--user-data-dir=${temporary}`, `--profile-directory=${profile}`,
      '--remote-debugging-port=0', '--remote-allow-origins=*', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions', '--disable-sync',
      '--disable-background-networking', 'about:blank',
    ];
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');
    child = spawn(browser, args, { stdio: 'ignore' });
    const port = await devToolsPort(temporary, child);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{
      readonly type?: string;
      readonly webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) return undefined;
    client = await CdpClient.connect(page.webSocketDebuggerUrl);
    await client.send('Network.enable');
    const result = await client.send<{ readonly cookies?: readonly BrowserCookie[] }>('Network.getAllCookies');
    return cookieHeader(result.cookies ?? []);
  } finally {
    if (client) {
      try { await client.send('Browser.close'); } catch { /* Already closed. */ }
      client.close();
    }
    if (child?.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>(resolve => child?.once('exit', () => resolve())),
        sleep(2_000),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

async function cookieWorks(cookie: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/user/enrollments', ECHO_URL), { headers: { Cookie: cookie } });
    return response.ok;
  } catch {
    return false;
  }
}

export async function captureEchoCookie(): Promise<string> {
  for (const spec of specs()) {
    const browser = await executable(spec.executables);
    if (!browser) continue;
    const configuredDirectory = process.env.ECHO_BROWSER_DATA_DIR?.trim();
    const dataDirectories = configuredDirectory ? [configuredDirectory] : spec.dataDirectories;
    const profile = process.env.ECHO_BROWSER_PROFILE?.trim() || 'Default';

    // With a running browser this opens a tab in that exact browser/profile.
    // It never points the visible browser at the temporary cookie snapshot.
    const opener = spawn(browser, [`--profile-directory=${profile}`, UQ_ECHO_LAUNCH_URL.href], {
      detached: true,
      stdio: 'ignore',
    });
    opener.unref();
    process.stderr.write('Opened the UQ Echo360 launch in your existing browser. Complete login if prompted…\n');

    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      for (const dataDirectory of dataDirectories) {
        try {
          const cookie = await readProfileCookie(browser, dataDirectory, profile);
          if (cookie && await cookieWorks(cookie)) return cookie;
        } catch {
          // The next browser-cookie flush may succeed.
        }
      }
      await sleep(2_000);
    }
    throw new Error('Timed out waiting for a valid Echo360 cookie in the existing browser profile.');
  }
  throw new Error('No Brave, Chrome, or Chromium installation was found. Set ECHO_BROWSER.');
}
