import { spawn, type ChildProcess } from 'node:child_process';
import { constants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import CDP from 'chrome-remote-interface';

import { cloudFrontCookieExpiry, cookieMap } from './auth.js';

const ECHO_HOST = 'echo360.net.au';
const LOGIN_URL = 'https://learn.uq.edu.au/webapps/blackboard/execute/blti/launchPlacement?blti_placement_id=_1088_1&content_id=_13163361_1&course_id=_206914_1&wrapped=true&from_ultra=true';
const PROFILE = 'Default';
const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

async function copyIfPresent(source: string, destination: string): Promise<boolean> {
  try {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    return true;
  } catch {
    return false;
  }
}

async function snapshotBrave(source: string, destination: string): Promise<void> {
  if (!await copyIfPresent(join(source, 'Local State'), join(destination, 'Local State'))) {
    throw new Error(`Brave data directory not found: ${source}`);
  }
  for (const filename of ['Preferences', 'Secure Preferences']) {
    await copyIfPresent(join(source, PROFILE, filename), join(destination, PROFILE, filename));
  }
  const sourceCookies = join(source, PROFILE, 'Network', 'Cookies');
  const destinationCookies = join(destination, PROFILE, 'Network', 'Cookies');
  if (!await copyIfPresent(sourceCookies, destinationCookies)) throw new Error(`Brave ${PROFILE} has no cookies.`);
  for (const suffix of ['-wal', '-shm']) await copyIfPresent(sourceCookies + suffix, destinationCookies + suffix);
}

async function devToolsPort(directory: string, child: ChildProcess): Promise<number> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const port = Number((await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* Still starting. */ }
    if (child.exitCode !== null) throw new Error(`Brave cookie reader exited (${child.exitCode}).`);
    await sleep(50);
  }
  throw new Error('Brave cookie reader did not start.');
}

async function readBraveCookie(browser: string, dataDirectory: string): Promise<string | undefined> {
  const snapshot = await mkdtemp(join(tmpdir(), 'echomirror-cookie-'));
  let child: ChildProcess | undefined;
  try {
    await snapshotBrave(dataDirectory, snapshot);
    child = spawn(browser, [
      '--headless=new', `--user-data-dir=${snapshot}`, `--profile-directory=${PROFILE}`,
      '--remote-debugging-port=0', '--remote-allow-origins=*', '--disable-extensions',
      '--disable-sync', '--disable-background-networking', 'about:blank',
    ], { stdio: 'ignore' });
    const client = await CDP({ port: await devToolsPort(snapshot, child) });
    try {
      await client.Network.enable();
      const { cookies } = await client.Network.getAllCookies();
      const now = Date.now() / 1000;
      return cookies.filter(cookie => {
        const domain = cookie.domain.replace(/^\./, '');
        return (domain === ECHO_HOST || ECHO_HOST.endsWith(`.${domain}`))
          && (!cookie.expires || cookie.expires < 0 || cookie.expires > now);
      }).map(cookie => `${cookie.name}=${cookie.value}`).join('; ') || undefined;
    } finally {
      await client.Browser.close().catch(() => undefined);
      await client.close();
    }
  } finally {
    if (child?.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise<void>(resolve => child?.once('exit', () => resolve())), sleep(2_000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await rm(snapshot, { recursive: true, force: true });
  }
}

async function captureEchoCookie(): Promise<string> {
  const browser = process.env.ECHO_BROWSER?.trim() || '/usr/bin/brave';
  await access(browser, constants.X_OK).catch(() => {
    throw new Error(`Brave is not executable at ${browser}; set ECHO_BROWSER if needed.`);
  });
  const dataDirectory = process.env.ECHO_BROWSER_DATA_DIR?.trim()
    || join(homedir(), '.config', 'BraveSoftware', 'Brave-Browser');
  const opener = spawn(browser, [`--profile-directory=${PROFILE}`, LOGIN_URL], { detached: true, stdio: 'ignore' });
  opener.unref();
  process.stderr.write(`Opened UQ Echo360 in Brave's ${PROFILE} profile. Complete login if prompted…\n`);

  for (let attempt = 0; attempt < 150; attempt += 1) {
    const cookie = await readBraveCookie(browser, dataDirectory).catch(() => undefined);
    if (cookie) {
      const response = await fetch(`https://${ECHO_HOST}/user/enrollments`, { headers: { Cookie: cookie } }).catch(() => undefined);
      if (response?.ok) return cookie;
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for a valid Echo360 cookie in Brave's ${PROFILE} profile.`);
}

export const COOKIE_FILE = 'cookies';

export const TOKEN_HELP = `echomirror normally opens a browser and captures the Echo360 session itself.
Set ECHO_BROWSER if Brave is not installed at /usr/bin/brave.
You can still pass a raw Cookie request-header value with --token as a fallback.`;

function expiry(cookie: string): Date | undefined {
  const cf = cloudFrontCookieExpiry(cookie);
  if (cf) return cf;
  const jwt = cookieMap(cookie).get('ECHO_JWT');
  if (!jwt) return undefined;
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp ? new Date(payload.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

export function assertTokenValid(cookie: string): void {
  const exp = expiry(cookie);
  if (exp && exp.getTime() <= Date.now()) {
    throw new Error(`Echo token expired at ${exp.toISOString()}.\n${TOKEN_HELP}`);
  }
}

function normalizeCookie(value: string): string {
  return value.trim();
}

export interface TokenOptions {
  readonly forceBrowser?: boolean;
  readonly capture?: () => Promise<string>;
}

export async function loadToken(provided?: string, options: TokenOptions = {}): Promise<string> {
  let cookie: string | undefined;

  if (provided !== undefined) {
    cookie = normalizeCookie(provided);
    if (!cookie) throw new Error(`No Echo token provided.\n${TOKEN_HELP}`);
    assertTokenValid(cookie);
    writeFileSync(COOKIE_FILE, cookie + '\n', { encoding: 'utf8', mode: 0o600 });
  } else if (!options.forceBrowser && existsSync(COOKIE_FILE)) {
    cookie = normalizeCookie(readFileSync(COOKIE_FILE, 'utf8'));
    try {
      assertTokenValid(cookie);
      return cookie;
    } catch {
      cookie = undefined;
    }
  }

  if (!cookie) {
    cookie = normalizeCookie(await (options.capture ?? captureEchoCookie)());
    if (!cookie) throw new Error(`Browser returned no Echo token.\n${TOKEN_HELP}`);
    writeFileSync(COOKIE_FILE, cookie + '\n', { encoding: 'utf8', mode: 0o600 });
  }
  assertTokenValid(cookie);
  return cookie;
}
