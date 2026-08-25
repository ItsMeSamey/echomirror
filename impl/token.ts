import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import CDP from 'chrome-remote-interface';
import { getSetCookieHeaders, mergeSetCookies } from './auth.js';

const ECHO_HOST = 'echo360.net.au';
const LOGIN_URL = 'https://learn.uq.edu.au/webapps/blackboard/execute/blti/launchPlacement?blti_placement_id=_1088_1&content_id=_13163361_1&course_id=_206914_1&wrapped=true&from_ultra=true';
const SNAPSHOT_PROFILE = 'Default';
const DEVTOOLS_START_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;
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
  readonly name: string;
  readonly value: string;
  readonly path: string;
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
        { name: 'Chromium', executable: join(local, 'Chromium', 'Application', 'chrome.exe'), dataDirectory: join(local, 'Chromium', 'User Data') },
        { name: 'Chromium', executable: join(programFiles, 'Chromium', 'Application', 'chrome.exe'), dataDirectory: join(local, 'Chromium', 'User Data') },
        { name: 'Chromium', executable: join(programFilesX86, 'Chromium', 'Application', 'chrome.exe'), dataDirectory: join(local, 'Chromium', 'User Data') },
        { name: 'Chromium', executable: 'chromium.exe', dataDirectory: join(local, 'Chromium', 'User Data') },
        { name: 'Vivaldi', executable: join(local, 'Vivaldi', 'Application', 'vivaldi.exe'), dataDirectory: join(local, 'Vivaldi', 'User Data') },
        { name: 'Vivaldi', executable: join(programFiles, 'Vivaldi', 'Application', 'vivaldi.exe'), dataDirectory: join(local, 'Vivaldi', 'User Data') },
        { name: 'Vivaldi', executable: join(programFilesX86, 'Vivaldi', 'Application', 'vivaldi.exe'), dataDirectory: join(local, 'Vivaldi', 'User Data') },
        { name: 'Opera', executable: join(local, 'Programs', 'Opera', 'opera.exe'), dataDirectory: join(roaming, 'Opera Software', 'Opera Stable') },
        { name: 'Opera', executable: join(programFiles, 'Opera', 'opera.exe'), dataDirectory: join(roaming, 'Opera Software', 'Opera Stable') },
        { name: 'Opera', executable: join(programFilesX86, 'Opera', 'opera.exe'), dataDirectory: join(roaming, 'Opera Software', 'Opera Stable') },
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
    case 'linux': {
      const absoluteEnv = (name: string): string | undefined => {
        const value = process.env[name]?.trim();
        return value && isAbsolute(value) ? value : undefined;
      };
      const config = absoluteEnv('XDG_CONFIG_HOME') ?? join(home, '.config');
      const chromeConfig = absoluteEnv('CHROME_CONFIG_HOME') ?? config;
      const chromeUserData = absoluteEnv('CHROME_USER_DATA_DIR');
      return [
        ...(chromeUserData ? [
          { name: 'Google Chrome', executable: 'google-chrome', dataDirectory: chromeUserData },
          { name: 'Google Chrome', executable: 'google-chrome-stable', dataDirectory: chromeUserData },
          { name: 'Chromium', executable: 'chromium', dataDirectory: chromeUserData },
          { name: 'Chromium', executable: 'chromium-browser', dataDirectory: chromeUserData },
        ] : []),
        { name: 'Brave', executable: 'brave-browser', dataDirectory: join(config, 'BraveSoftware', 'Brave-Browser') },
        { name: 'Brave', executable: 'brave', dataDirectory: join(config, 'BraveSoftware', 'Brave-Browser') },
        { name: 'Google Chrome', executable: 'google-chrome', dataDirectory: join(chromeConfig, 'google-chrome') },
        { name: 'Google Chrome', executable: 'google-chrome-stable', dataDirectory: join(chromeConfig, 'google-chrome') },
        { name: 'Chromium', executable: 'chromium', dataDirectory: join(chromeConfig, 'chromium') },
        { name: 'Chromium', executable: 'chromium-browser', dataDirectory: join(chromeConfig, 'chromium') },
        { name: 'Chromium', executable: 'chromium', dataDirectory: join(home, 'snap', 'chromium', 'common', 'chromium') },
        { name: 'Chromium', executable: 'chromium-browser', dataDirectory: join(home, 'snap', 'chromium', 'common', 'chromium') },
        { name: 'Microsoft Edge', executable: 'microsoft-edge', dataDirectory: join(config, 'microsoft-edge') },
        { name: 'Microsoft Edge', executable: 'microsoft-edge-stable', dataDirectory: join(config, 'microsoft-edge') },
        { name: 'Vivaldi', executable: 'vivaldi', dataDirectory: join(config, 'vivaldi') },
        { name: 'Vivaldi', executable: 'vivaldi-stable', dataDirectory: join(config, 'vivaldi') },
        { name: 'Opera', executable: 'opera', dataDirectory: join(config, 'opera') },
      ];
    }
    default:
      return [];
  }
}

async function executablePath(candidate: string): Promise<string | undefined> {
  const explicitPath = isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\');
  const suffixes = process.platform === 'win32' && !explicitPath && !/\.[^\\/]+$/.test(candidate)
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const directories = explicitPath ? [''] : (process.env.PATH ?? '').split(delimiter).map(directory => directory || '.');
  const mode = process.platform === 'win32' ? constants.F_OK : constants.X_OK;
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const name = explicitPath ? candidate : join(directory, candidate + suffix);
      try {
        await access(name, mode);
        return await realpath(name);
      } catch { /* Try the next location. */ }
    }
  }
  return undefined;
}

function profileHasCookies(dataDirectory: string, profile: string): boolean {
  const root = profile === '.' ? dataDirectory : join(dataDirectory, profile);
  return existsSync(join(root, 'Network', 'Cookies')) || existsSync(join(root, 'Cookies'));
}

function safeProfileName(value: string): boolean {
  return value !== '.' && value !== '..' && value !== 'System Profile' && value !== 'Guest Profile'
    && basename(value) === value && !value.includes('/') && !value.includes('\\');
}

async function localStateProfiles(dataDirectory: string): Promise<string[]> {
  try {
    const state = JSON.parse(await readFile(join(dataDirectory, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: Record<string, unknown> };
    };
    return Object.keys(state.profile?.info_cache ?? {}).filter(safeProfileName);
  } catch {
    return [];
  }
}

async function profilesIn(dataDirectory: string): Promise<string[]> {
  const profiles = new Set<string>();
  if (existsSync(join(dataDirectory, 'Preferences')) || profileHasCookies(dataDirectory, '.')) profiles.add('.');
  try {
    const entries = await readdir(dataDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)) profiles.add(entry.name);
    }
  } catch { /* Missing browser data directory. */ }
  for (const profile of await localStateProfiles(dataDirectory)) {
    if (existsSync(join(dataDirectory, profile))) profiles.add(profile);
  }
  if (profiles.size === 0 && existsSync(join(dataDirectory, 'Local State'))) profiles.add('Default');
  return [...profiles].sort((a, b) => a === '.' ? -1 : b === '.' ? 1 : a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b, undefined, { numeric: true }));
}

async function discoverBrowserProfiles(): Promise<BrowserProfile[]> {
  const browserOverride = process.env.ECHO_BROWSER?.trim();
  const dataOverride = process.env.ECHO_BROWSER_DATA_DIR?.trim();
  if (Boolean(browserOverride) !== Boolean(dataOverride)) {
    throw new Error('ECHO_BROWSER and ECHO_BROWSER_DATA_DIR must be set together.');
  }
  const definitions = browserOverride && dataOverride
    ? [{ name: 'Chromium browser', executable: browserOverride, dataDirectory: dataOverride }]
    : browserDefinitions();

  const installations: BrowserInstallation[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    const executable = await executablePath(definition.executable);
    if (!executable || !definition.dataDirectory) continue;
    const key = `${executable}\0${definition.dataDirectory}`;
    if (seen.has(key)) continue;
    seen.add(key);
    installations.push({ ...definition, executable });
  }

  const profiles: BrowserProfile[] = [];
  for (const browser of installations) {
    const discovered = await profilesIn(browser.dataDirectory);
    for (const profile of discovered.length > 0 ? discovered : ['Default']) profiles.push({ ...browser, profile });
  }
  return profiles;
}

async function copyIfPresent(source: string, destination: string): Promise<boolean> {
  try {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isSnapChromium(browser: BrowserInstallation): boolean {
  return process.platform === 'linux' && browser.dataDirectory.includes(join('snap', 'chromium', 'common', 'chromium'));
}

async function temporaryProfile(browser: BrowserInstallation, prefix: string): Promise<string> {
  if (!isSnapChromium(browser)) return await mkdtemp(join(tmpdir(), prefix));
  const parent = dirname(browser.dataDirectory);
  await mkdir(parent, { recursive: true });
  return await mkdtemp(join(parent, prefix));
}

async function snapshotChromium(source: BrowserProfile, destination: string): Promise<string> {
  if (!await copyIfPresent(join(source.dataDirectory, 'Local State'), join(destination, 'Local State'))) {
    throw new Error(`${source.name} data directory has no Local State: ${source.dataDirectory}`);
  }
  const sourceRoot = source.profile === '.' ? source.dataDirectory : join(source.dataDirectory, source.profile);
  const destinationProfile = source.profile === '.' ? '.' : SNAPSHOT_PROFILE;
  const destinationRoot = destinationProfile === '.' ? destination : join(destination, destinationProfile);
  for (const filename of ['Preferences', 'Secure Preferences']) {
    await copyIfPresent(join(sourceRoot, filename), join(destinationRoot, filename));
  }
  let copied = false;
  for (const relative of [join('Network', 'Cookies'), 'Cookies']) {
    const sourceCookies = join(sourceRoot, relative);
    const destinationCookies = join(destinationRoot, relative);
    if (!await copyIfPresent(sourceCookies, destinationCookies)) continue;
    copied = true;
    for (const suffix of ['-wal', '-shm', '-journal']) await copyIfPresent(sourceCookies + suffix, destinationCookies + suffix);
  }
  if (!copied) throw new Error(`${source.name} ${source.profile} has no cookie database.`);
  return destinationProfile;
}

async function devToolsPort(directory: string, child: ChildProcess, name: string): Promise<number> {
  let spawnError: Error | undefined;
  const onError = (error: Error): void => { spawnError = error; };
  child.once('error', onError);
  try {
    const deadline = Date.now() + DEVTOOLS_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`Could not start ${name}: ${spawnError.message}`, { cause: spawnError });
      try {
        const port = Number((await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        if (Number.isInteger(port) && port > 0) return port;
      } catch { /* Still starting. */ }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`${name} cookie reader exited before opening a debugging port.`);
      }
      await sleep(50);
    }
    throw new Error(`${name} cookie reader did not start.`);
  } finally {
    child.off('error', onError);
  }
}

async function stopBrowser(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ignoreError = (): void => undefined;
  child.on('error', ignoreError);
  try {
    const waitForExit = (milliseconds: number): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), sleep(milliseconds)]);
    };
    child.kill();
    await waitForExit(2_000);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(2_000);
    }
  } finally {
    child.off('error', ignoreError);
  }
}


async function removeTemporaryDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: could not remove temporary browser profile ${directory}: ${message}\n`);
  }
}

async function connectCdp(port: number, name: string): Promise<Awaited<ReturnType<typeof CDP>>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await CDP({ port });
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Could not connect to ${name} debugging port${detail}`, { cause: lastError });
}

async function echoCookieFrom(client: Awaited<ReturnType<typeof CDP>>): Promise<string | undefined> {
  const { cookies } = await client.Network.getCookies({ urls: [`https://${ECHO_HOST}/user/enrollments`] }) as { cookies: ChromiumCookie[] };
  return cookies.sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ') || undefined;
}

async function validateEchoCookie(cookie: string): Promise<string | undefined> {
  const response = await fetch(`https://${ECHO_HOST}/user/enrollments`, {
    headers: { Cookie: cookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status !== 200 || response.headers.get('content-type')?.includes('json') !== true) return undefined;
  return mergeSetCookies(cookie, getSetCookieHeaders(response.headers));
}

async function readChromiumCookie(source: BrowserProfile): Promise<string | undefined> {
  const snapshot = await temporaryProfile(source, '.echomirror-cookie-');
  let child: ChildProcess | undefined;
  try {
    const snapshotProfile = await snapshotChromium(source, snapshot);
    const args = [
      '--headless', `--user-data-dir=${snapshot}`, '--remote-debugging-port=0',
      '--disable-extensions', '--disable-sync', '--disable-background-networking', 'about:blank',
    ];
    if (snapshotProfile !== '.') args.splice(2, 0, `--profile-directory=${snapshotProfile}`);
    child = spawn(source.executable, args, { stdio: 'ignore' });
    const client = await connectCdp(await devToolsPort(snapshot, child, source.name), source.name);
    try {
      return await echoCookieFrom(client);
    } finally {
      await client.Browser.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  } finally {
    await stopBrowser(child);
    await removeTemporaryDirectory(snapshot);
  }
}

async function loginWithTemporaryProfile(browser: BrowserInstallation): Promise<string> {
  const directory = await temporaryProfile(browser, '.echomirror-login-');
  let child: ChildProcess | undefined;
  let client: Awaited<ReturnType<typeof CDP>> | undefined;
  try {
    child = spawn(browser.executable, [
      `--user-data-dir=${directory}`, '--profile-directory=Default', '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', LOGIN_URL,
    ], { stdio: 'ignore' });
    const port = await devToolsPort(directory, child, browser.name);
    client = await connectCdp(port, browser.name);
    process.stderr.write(`Opened UQ Echo360 in a temporary ${browser.name} profile. Complete login if prompted…\n`);
    for (let attempt = 0; attempt < 150; attempt += 1) {
      let cookie: string | undefined;
      try {
        cookie = await echoCookieFrom(client);
      } catch {
        await client.close().catch(() => undefined);
        client = await connectCdp(port, browser.name);
        cookie = await echoCookieFrom(client);
      }
      const validated = cookie ? await validateEchoCookie(cookie).catch(() => undefined) : undefined;
      if (validated) return validated;
      await sleep(2_000);
    }
    throw new Error(`Timed out waiting for a valid Echo360 cookie in ${browser.name}.`);
  } finally {
    if (client) {
      await client.Browser.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
    await stopBrowser(child);
    await removeTemporaryDirectory(directory);
  }
}

async function captureEchoCookie(): Promise<string> {
  const profiles = await discoverBrowserProfiles();
  if (profiles.length === 0) {
    throw new Error('No supported Chromium browser profile found. Install Chrome, Chromium, Brave, Edge, Vivaldi, or Opera, or set ECHO_BROWSER and ECHO_BROWSER_DATA_DIR.');
  }

  let lastFailure = 'no Echo360 cookies found';
  const readValidCookie = async (profile: BrowserProfile): Promise<string | undefined> => {
    if (!profileHasCookies(profile.dataDirectory, profile.profile)) {
      lastFailure = `${profile.name} ${profile.profile} has no cookie database`;
      return undefined;
    }
    try {
      const cookie = await readChromiumCookie(profile);
      if (!cookie) {
        lastFailure = `no Echo360 cookies found in ${profile.name} ${profile.profile}`;
        return undefined;
      }
      if (await validateEchoCookie(cookie)) return cookie;
      lastFailure = `Echo360 rejected the browser cookies from ${profile.name} ${profile.profile}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    return undefined;
  };

  for (const profile of profiles) {
    const existing = await readValidCookie(profile);
    if (existing) return existing;
  }

  const installationScore = (profile: BrowserProfile): number =>
    (profileHasCookies(profile.dataDirectory, profile.profile) ? 2 : 0)
    + (existsSync(join(profile.dataDirectory, 'Local State')) ? 1 : 0)
    + (isSnapChromium(profile) ? 1 : 0);
  const installations: BrowserInstallation[] = [];
  const loginExecutables = new Set<string>();
  for (const profile of [...profiles].sort((a, b) => installationScore(b) - installationScore(a))) {
    if (loginExecutables.has(profile.executable)) continue;
    loginExecutables.add(profile.executable);
    installations.push(profile);
  }
  let loginFailure = 'no browser login attempted';
  for (const browser of installations) {
    try {
      return await loginWithTemporaryProfile(browser);
    } catch (error) {
      loginFailure = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`${loginFailure} Previous profile scan result: ${lastFailure}.`);
}

export const COOKIE_FILE = 'cookies';

function storeCookie(cookie: string): void {
  writeFileSync(COOKIE_FILE, cookie + '\n', { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(COOKIE_FILE, 0o600);
}

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
    storeCookie(cookie);
  } else if (!options.forceBrowser && existsSync(COOKIE_FILE)) {
    cookie = normalizeCookie(readFileSync(COOKIE_FILE, 'utf8'));
    if (cookie) return cookie;
  }

  if (!cookie) {
    cookie = normalizeCookie(await (options.capture ?? captureEchoCookie)());
    if (!cookie) throw new Error(`Browser returned no Echo token.\n${TOKEN_HELP}`);
    storeCookie(cookie);
  }
  return cookie;
}
