import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COOKIE_FILE, TOKEN_HELP, loadToken } from '../dist/impl/token.js';

async function inTempCwd(fn) {
  const original = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'echomirror-token-'));
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(original);
  }
}

test('--token stores the cookie in ./cookies and later restores it', async () => {
  await inTempCwd(async dir => {
    const cookie = 'session=abc; other=def';
    assert.equal(await loadToken(cookie), cookie);
    assert.equal(COOKIE_FILE, 'cookies');
    assert.equal(readFileSync(join(dir, 'cookies'), 'utf8'), cookie + '\n');
    assert.equal(await loadToken(), cookie);
  });
});

test('missing cookies file explains Network-tab extraction', async () => {
  await inTempCwd(async () => {
    await assert.rejects(loadToken(), error => {
      assert.match(error.message, /save that value to \.\/cookies/i);
      assert.match(error.message, /DevTools -> Network/);
      assert.doesNotMatch(error.message, /document\.cookie/);
      return true;
    });
  });
});

test('cached cookies are checked for expiry when restored', async () => {
  await inTempCwd(async dir => {
    const payload = Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url');
    writeFileSync(join(dir, 'cookies'), `ECHO_JWT=x.${payload}.x\n`, 'utf8');
    await assert.rejects(loadToken(), /Echo token expired at/);
  });
});

test('token help consistently names ./cookies', () => {
  assert.match(TOKEN_HELP, /\.\/cookies/);
  assert.doesNotMatch(TOKEN_HELP, /\.\/token/);
});
