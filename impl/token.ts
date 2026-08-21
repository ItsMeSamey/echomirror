import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { cloudFrontCookieExpiry, cookieMap } from './auth.js';
import { captureEchoCookie } from './browser.js';

export const COOKIE_FILE = 'cookies';

export const TOKEN_HELP = `echomirror normally opens a browser and captures the Echo360 session itself.
Set ECHO_BROWSER if Brave, Chrome, or Chromium is not found automatically.
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
