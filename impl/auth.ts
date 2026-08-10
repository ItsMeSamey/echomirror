function splitCookieHeader(cookie: string): string[] {
  return cookie.split(';').map(part => part.trim()).filter(Boolean);
}

export function cookieMap(cookie: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of splitCookieHeader(cookie)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    result.set(part.slice(0, eq).trim(), part.slice(eq + 1));
  }
  return result;
}

function splitSetCookieHeader(value: string): string[] {
  // The comma in Expires=Wed, 21 Oct ... is not followed by a cookie-name= pair,
  // while the separator between cookies is. This works for both Node and Bun's
  // occasionally-combined Set-Cookie representation.
  return value.split(/,(?=\s*[^=;,\s]+\s*=)/).map(part => part.trim()).filter(Boolean);
}


export function getSetCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === 'function') {
    const values = extended.getSetCookie().flatMap(splitSetCookieHeader);
    if (values.length) return values;
  }
  const combined = headers.get('set-cookie');
  return combined ? splitSetCookieHeader(combined) : [];
}

export function mergeSetCookies(cookie: string, setCookieHeaders: string[]): string {
  const values = cookieMap(cookie);
  for (const setCookie of setCookieHeaders) {
    const first = setCookie.split(';', 1)[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1);
    if (/max-age\s*=\s*0/i.test(setCookie) || /expires\s*=\s*Thu,\s*01 Jan 1970/i.test(setCookie)) {
      values.delete(name);
    } else {
      values.set(name, value);
    }
  }
  return [...values.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function cloudFrontCookieExpiry(cookie: string): Date | undefined {
  const policy = cookieMap(cookie).get('CloudFront-Policy');
  if (!policy) return undefined;
  try {
    let normalized = policy.replace(/_/g, '=').replace(/-/g, '+').replace(/~/g, '/');
    while (normalized.length % 4) normalized += '=';
    const parsed = JSON.parse(atob(normalized)) as {
      Statement?: Array<{ Condition?: { DateLessThan?: { 'AWS:EpochTime'?: number } } }>;
    };
    const epoch = parsed.Statement?.[0]?.Condition?.DateLessThan?.['AWS:EpochTime'];
    return typeof epoch === 'number' ? new Date(epoch * 1000) : undefined;
  } catch {
    return undefined;
  }
}
