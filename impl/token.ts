import { spawn, type ChildProcess } from 'node:child_process';
import { constants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import CDP from 'chrome-remote-interface';

const ECHO_HOST = 'echo360.net.au';
const LOGIN_URL = 'https://learn.uq.edu.au/webapps/blackboard/execute/blti/launchPlacement?blti_placement_id=_1088_1&content_id=_13163361_1&course_id=_206914_1&wrapped=true&from_ultra=true';
const SNAPSHOT_PROFILE = 'Default';
const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

interface BrowserInstallation {
  readonly name: string;
  readonly executable: string;
  readonly dataDirectory: string;
}

interface BrowserProfile extends BrowserInstallation {
  readonly profile: string;
}

interface ChromiumCookie {
  readonly domain: string;
  readonly expires?: number;
  readonly name: string;
  readonly value: string;
}

function browserDefinitions(): readonly BrowserInstallation[] {
  const home = homedir();
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';

  switch (process.platform) {
    case 'win32':
      return [
        { name: 'Brave', executable: join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), dataDirectory: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
        { name: 'Brave', executable: join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), dataDirectory: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
        { name: 'Brave', executable: join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), dataDirectory: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
        { name: 'Google Chrome', executable: join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'), dataDirectory: join(local, 'Google', 'Chrome', 'User Data') },
        { name: 'Google Chrome', executable: join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'), dataDirectory: join(local, 'Google', 'Chrome', 'User Data') },
        { name: 'Google Chrome', executable: join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), dataDirectory: join(local, 'Google', 'Chrome', 'User Data') },
        { name: 'Microsoft Edge', executable: join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), dataDirectory: join(local, 'Microsoft', 'Edge', 'User Data') },
        { name: 'Microsoft Edge', executable: join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), dataDirectory: join(local, 'Microsoft', 'Edge', 'User Data') },
        { name: 'Microsoft Edge', executable: join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), dataDirectory: join(local, 'Microsoft', 'Edge', 'User Data') },
        { name: 'Chromium', executable: 'chromium.exe', dataDirectory: join(local, 'Chromium', 'User Data') },
        { name: 'Vivaldi', executable: join(local, 'Vivaldi', 'Application', 'vivaldi.exe'), dataDirectory: join(local, 'Vivaldi', 'User Data') },
        { name: 'Vivaldi', executable: join(programFiles, 'Vivaldi', 'Application', 'vivaldi.exe'), dataDirectory: join(local, 'Vivaldi', 'User Data') },
        { name: 'Opera', executable: join(local, 'Programs', 'Opera', 'opera.exe'), dataDirectory: join(roaming, 'Opera Software', 'Opera Stable') },
        { name: 'Opera', executable: join(programFiles, 'Opera', 'opera.exe'), dataDirectory: join(roaming, 'Opera Software', 'Opera Stable') },
      ];
    case 'darwin': {
      const support = join(home, 'Library', 'Application Support');
      const apps = ['/Applications', join(home, 'Applications')];
      const browsers = [
        { name: 'Brave', app: 'Brave Browser.app/Contents/MacOS/Brave Browser', dataDirectory: join(support, 'BraveSoftware', 'Brave-Browser') },
        { name: 'Google Chrome', app: 'Google Chrome.app/Contents/MacOS/Google Chrome', dataDirectory: join(support, 'Google', 'Chrome') },
        { name: 'Microsoft Edge', app: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', dataDirectory: join(support, 'Microsoft Edge') },
        { name: 'Chromium', app: 'Chromium.app/Contents/MacOS/Chromium', dataDirectory: join(support, 'Chromium') },
        { name: 'Vivaldi', app: 'Vivaldi.app/Contents/MacOS/Vivaldi', dataDirectory: join(support, 'Vivaldi') },
        { name: 'Opera', app: 'Opera.app/Contents/MacOS/Opera', dataDirectory: join(support, 'com.operasoftware.Opera') },
      ];
      return browsers.flatMap(browser => apps.map(root => ({ name: browser.name, executable: join(root, browser.app), dataDirectory: browser.dataDirectory })));
    }
    default: {
      const config = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
      return [
        { name: 'Brave', executable: 'brave-browser', dataDirectory: join(config, 'BraveSoftware', 'Brave-Browser') },
        { name: 'Brave', executable: 'brave', dataDirectory: join(config, 'BraveSoftware', 'Brave-Browser') },
        { name: 'Google Chrome', executable: 'google-chrome', dataDirectory: join(config, 'google-chrome') },
        { name: 'Google Chrome', executable: 'google-chrome-stable', dataDirectory: join(config, 'google-chrome') },
        { name: 'Chromium', executable: 'chromium', dataDirectory: join(config, 'chromium') },
        { name: 'Chromium', executable: 'chromium-browser', dataDirectory: join(config, 'chromium') },
        { name: 'Microsoft Edge', executable: 'microsoft-edge', dataDirectory: join(config, 'microsoft-edge') },
        { name: 'Microsoft Edge', executable: 'microsoft-edge-stable', dataDirectory: join(config, 'microsoft-edge') },
        { name: 'Vivaldi', executable: 'vivaldi', dataDirectory: join(config, 'vivaldi') },
        { name: 'Vivaldi', executable: 'vivaldi-stable', dataDirectory: join(config, 'vivaldi') },
        { name: 'Opera', executable: 'opera', dataDirectory: join(config, 'opera') },
      ];
    }
  }
}

async function executablePath(candidate: string): Promise<string | undefined> {
  const names = isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\')
    ? [candidate]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, candidate));
  for (const name of names) {
    try {
      await access(name, constants.X_OK);
      return name;
    } catch { /* Try the next location. */ }
  }
  return undefined;
}

function profileHasCookies(dataDirectory: string, profile: string): boolean {
  const root = profile === '.' ? dataDirectory : join(dataDirectory, profile);
  return existsSync(join(root, 'Network', 'Cookies')) || existsSync(join(root, 'Cookies'));
}

async function profilesIn(dataDirectory: string): Promise<string[]> {
  const profiles: string[] = [];
  if (existsSync(join(dataDirectory, 'Preferences')) || profileHasCookies(dataDirectory, '.')) profiles.push('.');
  try {
    const entries = await readdir(dataDirectory, { withFileTypes: true });
    const names = entries.filter(entry => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
      .map(entry => entry.name)
      .sort((a, b) => a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b, undefined, { numeric: true }));
    profiles.push(...names);
  } catch { /* Missing browser data directory. */ }
  if (profiles.length === 0 && existsSync(join(dataDirectory, 'Local State'))) profiles.push('Default');
  return profiles;
}

async function discoverBrowserProfiles(): Promise<BrowserProfile[]> {
  const browserOverride = process.env.ECHO_BROWSER?.trim();
  const dataOverride = process.env.ECHO_BROWSER_DATA_DIR?.trim();
  const definitions = browserOverride
    ? [{ name: 'Chromium browser', executable: browserOverride, dataDirectory: dataOverride ?? browserDefinitions()[0]?.dataDirectory ?? '' }]
    : browserDefinitions().map(browser => dataOverride ? { ...browser, dataDirectory: dataOverride } : browser);

  const installations: BrowserInstallation[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    const executable = await executablePath(definition.executable);
    if (!executable || !definition.dataDirectory || !existsSync(definition.dataDirectory)) continue;
    const key = `${executable}\0${definition.dataDirectory}`;
    if (seen.has(key)) continue;
    seen.add(key);
    installations.push({ ...definition, executable });
  }

  const profiles: BrowserProfile[] = [];
  for (const browser of installations) {
    for (const profile of await profilesIn(browser.dataDirectory)) profiles.push({ ...browser, profile });
  }
  return profiles;
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

async function snapshotChromium(source: BrowserProfile, destination: string): Promise<void> {
  if (!await copyIfPresent(join(source.dataDirectory, 'Local State'), join(destination, 'Local State'))) {
    throw new Error(`${source.name} data directory has no Local State: ${source.dataDirectory}`);
  }
  const profileRoot = source.profile === '.' ? source.dataDirectory : join(source.dataDirectory, source.profile);
  for (const filename of ['Preferences', 'Secure Preferences']) {
    await copyIfPresent(join(profileRoot, filename), join(destination, SNAPSHOT_PROFILE, filename));
  }
  let copied = false;
  for (const relative of [join('Network', 'Cookies'), 'Cookies']) {
    const sourceCookies = join(profileRoot, relative);
    const destinationCookies = join(destination, SNAPSHOT_PROFILE, relative);
    if (!await copyIfPresent(sourceCookies, destinationCookies)) continue;
    copied = true;
    for (const suffix of ['-wal', '-shm', '-journal']) await copyIfPresent(sourceCookies + suffix, destinationCookies + suffix);
  }
  if (!copied) throw new Error(`${source.name} ${source.profile} has no cookie database.`);
}

async function devToolsPort(directory: string, child: ChildProcess, name: string): Promise<number> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const port = Number((await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* Still starting. */ }
    if (child.exitCode !== null) throw new Error(`${name} cookie reader exited (${child.exitCode}).`);
    await sleep(50);
  }
  throw new Error(`${name} cookie reader did not start.`);
}

async function readChromiumCookie(source: BrowserProfile): Promise<string | undefined> {
  const snapshot = await mkdtemp(join(tmpdir(), 'echomirror-cookie-'));
  let child: ChildProcess | undefined;
  try {
    await snapshotChromium(source, snapshot);
    child = spawn(source.executable, [
      '--headless=new', `--user-data-dir=${snapshot}`, `--profile-directory=${SNAPSHOT_PROFILE}`,
      '--remote-debugging-port=0', '--remote-allow-origins=*', '--disable-extensions',
      '--disable-sync', '--disable-background-networking', 'about:blank',
    ], { stdio: 'ignore' });
    const client = await CDP({ port: await devToolsPort(snapshot, child, source.name) });
    try {
      await client.Network.enable();
      const { cookies } = await client.Network.getAllCookies() as { cookies: ChromiumCookie[] };
      const now = Date.now() / 1000;
      return cookies.filter((cookie: ChromiumCookie) => {
        const domain = cookie.domain.replace(/^\./, '');
        return (domain === ECHO_HOST || ECHO_HOST.endsWith(`.${domain}`))
          && (!cookie.expires || cookie.expires < 0 || cookie.expires > now);
      }).map((cookie: ChromiumCookie) => `${cookie.name}=${cookie.value}`).join('; ') || undefined;
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
  const profiles = await discoverBrowserProfiles();
  if (profiles.length === 0) {
    throw new Error('No supported Chromium browser profile found. Install Chrome, Chromium, Brave, Edge, Vivaldi, or Opera, or set ECHO_BROWSER and ECHO_BROWSER_DATA_DIR.');
  }

  let lastFailure = 'no Echo360 cookies found';
  const readValidCookie = async (profile: BrowserProfile): Promise<string | undefined> => {
    try {
      const cookie = await readChromiumCookie(profile);
      if (!cookie) {
        lastFailure = `no Echo360 cookies found in ${profile.name} ${profile.profile}`;
        return undefined;
      }
      const response = await fetch(`https://${ECHO_HOST}/user/enrollments`, {
        headers: { Cookie: cookie },
        redirect: 'manual',
      });
      const isJson = response.headers.get('content-type')?.includes('json') === true;
      if (response.status === 200 && isJson) return cookie;
      lastFailure = response.status >= 300 && response.status < 400
        ? 'Echo360 redirected the browser session to login'
        : `Echo360 rejected the browser cookies with HTTP ${response.status}${isJson ? '' : ' (non-JSON response)'}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    return undefined;
  };

  for (const profile of profiles) {
    const existing = await readValidCookie(profile);
    if (existing) return existing;
  }

  const target = profiles[0]!;
  const profileArgs = target.profile === '.' ? [] : [`--profile-directory=${target.profile}`];
  const opener = spawn(target.executable, [`--user-data-dir=${target.dataDirectory}`, ...profileArgs, LOGIN_URL], { detached: true, stdio: 'ignore' });
  opener.unref();
  process.stderr.write(`Opened UQ Echo360 in ${target.name} (${target.profile}). Complete login if prompted…\n`);

  for (let attempt = 0; attempt < 150; attempt += 1) {
    const cookie = await readValidCookie(target);
    if (cookie) return cookie;
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for a valid Echo360 cookie in ${target.name} (${target.profile}): ${lastFailure}.`);
}

export const COOKIE_FILE = 'cookies';

export const TOKEN_HELP = `echomirror normally discovers Chrome, Chromium, Brave, Edge, Vivaldi, and Opera profiles, opens a browser when login is needed, and captures the Echo360 session itself on Linux, macOS, and Windows.
Set ECHO_BROWSER and ECHO_BROWSER_DATA_DIR to override automatic browser discovery.
You can still pass a raw Cookie request-header value with --token as a fallback.`;

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
    writeFileSync(COOKIE_FILE, cookie + '\n', { encoding: 'utf8', mode: 0o600 });
  } else if (!options.forceBrowser && existsSync(COOKIE_FILE)) {
    cookie = normalizeCookie(readFileSync(COOKIE_FILE, 'utf8'));
    if (cookie) return cookie;
  }

  if (!cookie) {
    cookie = normalizeCookie(await (options.capture ?? captureEchoCookie)());
    if (!cookie) throw new Error(`Browser returned no Echo token.\n${TOKEN_HELP}`);
    writeFileSync(COOKIE_FILE, cookie + '\n', { encoding: 'utf8', mode: 0o600 });
  }
  return cookie;
}
