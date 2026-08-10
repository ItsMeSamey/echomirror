import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { cloudFrontCookieExpiry, cookieMap } from './auth.js';

export const COOKIE_FILE = 'cookies';

export const TOKEN_HELP = `To extract the token:
1. Login to Echo360.
2. Open DevTools -> Network and reload the site.
3. Open an Echo360 request and copy the full Cookie request-header value.
4. Save that value to ./cookies, or pass it once with --token <cookie>.
`;

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

export async function loadToken(provided?: string): Promise<string> {
  let cookie: string | undefined;

  if (provided !== undefined) {
    cookie = normalizeCookie(provided);
    if (!cookie) throw new Error(`No Echo token provided.\n${TOKEN_HELP}`);
    assertTokenValid(cookie);
    writeFileSync(COOKIE_FILE, cookie + '\n', { encoding: 'utf8', mode: 0o600 });
  } else if (existsSync(COOKIE_FILE)) {
    cookie = normalizeCookie(readFileSync(COOKIE_FILE, 'utf8'));
  }

  if (!cookie) throw new Error(`No Echo token provided.\n${TOKEN_HELP}`);
  assertTokenValid(cookie);
  return cookie;
}
