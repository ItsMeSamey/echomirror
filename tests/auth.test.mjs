import test from 'node:test';
import assert from 'node:assert/strict';
import { getSetCookieHeaders, mergeSetCookies } from '../dist/impl/auth.js';

test('merges refreshed Echo/CloudFront cookies from lesson responses', () => {
  const headers = new Headers({
    'set-cookie': 'CloudFront-Policy=new-policy; Path=/; Secure, CloudFront-Signature=new-signature; Path=/; Secure',
  });
  const refreshed = mergeSetCookies(
    'ECHO_JWT=current; CloudFront-Policy=old-policy; CloudFront-Signature=old-signature',
    getSetCookieHeaders(headers),
  );
  assert.match(refreshed, /ECHO_JWT=current/);
  assert.match(refreshed, /CloudFront-Policy=new-policy/);
  assert.match(refreshed, /CloudFront-Signature=new-signature/);
  assert.doesNotMatch(refreshed, /old-policy|old-signature/);
});

test('lesson-page HTTP 403 is reported as an invalid ./cookies credential', async () => {
  const { getPageSession } = await import('../dist/impl/downloader.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('Forbidden', { status: 403 });
  try {
    await assert.rejects(getPageSession('https://echo360.net.au/lesson/test', 'session=abc'), error => {
      assert.match(error.message, /rejected \.\/cookies with HTTP 403/i);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
