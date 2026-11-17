// Regression tests for the Instagram Unified Login token exchange (patch 0003).
// Bundles the REAL patched instagram.provider.ts with stubbed Postiz imports and runs it
// against a mocked global fetch. Only dummy credentials are used; nothing touches Meta.
//
//   PROVIDER_PATH=<path to instagram.provider.ts> node --test patches/tests/
// needs: npm i --no-save esbuild dayjs (run from a folder that has node_modules).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(process.env.HARNESS_REQUIRE || import.meta.url);
const esbuild = require('esbuild');
const PROVIDER = process.env.PROVIDER_PATH;
assert.ok(PROVIDER, 'set PROVIDER_PATH to the patched instagram.provider.ts');

const STUBS = {
  '@gitroom/nestjs-libraries/services/make.secure.id':
    'export const makeSecureId = () => "stateid";',
  '@gitroom/helpers/utils/timer': 'export const timer = async () => {};',
  '@gitroom/helpers/utils/has.extension': 'export const hasExtension = () => false;',
  '@gitroom/nestjs-libraries/integrations/social.abstract': `
    export class NotEnoughScopes extends Error {}
    export class BadBody extends Error {}
    export class Disconnect extends Error {}
    export class SocialAbstract {
      checkScopes(required, got) {
        if (Array.isArray(got)) {
          if (!required.every((s) => got.includes(s))) throw new NotEnoughScopes();
          return true;
        }
        throw new Error('string scopes not used in this path');
      }
    }`,
  '@gitroom/nestjs-libraries/dtos/posts/providers-settings/instagram.dto':
    'export class InstagramDto {}',
  '@gitroom/nestjs-libraries/chat/rules.description.decorator':
    'export const Rules = () => () => {};',
  '@gitroom/nestjs-libraries/integrations/tool.decorator':
    'export const Tool = () => () => {};',
  '@gitroom/nestjs-libraries/integrations/dashboard.function.decorator':
    'export const DashboardFunction = () => () => {};',
  '@gitroom/nestjs-libraries/integrations/social/facebook.provider':
    'export const META_GRAPH_API_VERSION = "v25.0";',
};

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'igtest-')), 'provider.mjs');
await esbuild.build({
  entryPoints: [PROVIDER],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  nodePaths: [path.resolve(path.dirname(require.resolve('dayjs/package.json')), '..')],
  plugins: [
    {
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^@gitroom\// }, (a) => {
          if (a.path in STUBS) return { path: a.path, namespace: 'stub' };
          if (/social\.integrations\.interface$/.test(a.path))
            return { path: a.path, namespace: 'stub' };
          throw new Error('unstubbed import ' + a.path);
        });
        b.onResolve({ filter: /^@prisma\/client$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
          contents: STUBS[a.path] ?? 'export {};',
          loader: 'js',
        }));
      },
    },
  ],
});
const { InstagramProvider } = await import(pathToFileURL(out).href + '?' + Date.now());

// ---- helpers -------------------------------------------------------------
const APP_ID = 'DUMMYAPPID123';
const APP_SECRET = 'dummy-app-secret-NOT-REAL';
const USER_TOKEN = 'DUMMYSYSTEMUSERTOKEN';
const CODE = 'dummycode';
process.env.FACEBOOK_APP_ID = APP_ID;
process.env.FACEBOOK_APP_SECRET = APP_SECRET;
process.env.INSTAGRAM_CONFIG_ID = '999';
process.env.FRONTEND_URL = 'https://localhost:4443';

const json = (status, body) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

function mockFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: String(url), u, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const h = handlers.find((x) => u.pathname.endsWith(x.path));
    if (!h) throw new Error('unexpected request ' + u.pathname);
    return h.reply(u, init);
  };
  return calls;
}
const goodScopes = ['instagram_basic', 'instagram_content_publish', 'pages_show_list'];
const ok = (over = {}) => [
  { path: '/oauth/access_token', reply: () => json(200, { access_token: USER_TOKEN }) },
  {
    path: '/debug_token',
    reply: () => json(200, { data: { is_valid: true, scopes: goodScopes, expires_at: 0, user_id: '42', ...over } }),
  },
  { path: '/me', reply: () => json(200, { id: '42', name: 'System User' }) },
];
const run = () => new InstagramProvider().authenticateUnifiedLogin({ code: CODE });
const dump = (v) => JSON.stringify(v);

// ---- tests ---------------------------------------------------------------
test('debug_token is a GET with input_token in the query and the app bearer in the header', async () => {
  const calls = mockFetch(ok());
  await run();
  const dbg = calls.find((c) => c.u.pathname.endsWith('/debug_token'));
  assert.equal(dbg.method, 'GET');
  assert.equal(dbg.body, undefined);
  assert.equal(dbg.u.searchParams.get('input_token'), USER_TOKEN);
  assert.equal(dbg.headers.Authorization, `Bearer ${APP_ID}|${APP_SECRET}`);
  assert.equal(dbg.u.origin + dbg.u.pathname, 'https://graph.facebook.com/v25.0/debug_token');
});

test('code exchange stays a POST with secrets in the body, never in the URL', async () => {
  const calls = mockFetch(ok());
  await run();
  const ex = calls.find((c) => c.u.pathname.endsWith('/oauth/access_token'));
  assert.equal(ex.method, 'POST');
  const body = new URLSearchParams(ex.body);
  assert.equal(body.get('client_secret'), APP_SECRET);
  assert.equal(body.get('code'), CODE);
  assert.equal(body.get('redirect_uri'), 'https://localhost:4443/integrations/social/instagram');
  assert.equal(ex.u.search, '');
});

test('no request puts the app secret or the code in a URL; the user token appears in a URL only for debug_token', async () => {
  const calls = mockFetch(ok());
  await run();
  for (const c of calls) {
    assert.ok(!c.url.includes(APP_SECRET), 'secret in URL: ' + c.u.pathname);
    assert.ok(!c.url.includes(CODE), 'code in URL: ' + c.u.pathname);
    if (!c.u.pathname.endsWith('/debug_token')) assert.ok(!c.url.includes(USER_TOKEN), 'token in URL: ' + c.u.pathname);
  }
  const me = calls.find((c) => c.u.pathname.endsWith('/me'));
  assert.equal(me.method, 'GET');
  assert.equal(me.headers.Authorization, `Bearer ${USER_TOKEN}`);
});

test('every request uses the right method: POST only with a form body, GET otherwise', async () => {
  const calls = mockFetch(ok());
  await run();
  for (const c of calls) assert.equal(c.method, c.body ? 'POST' : 'GET', c.u.pathname);
});

test('success with a non-expiring token (expires_at 0) returns a long expiry and the token', async () => {
  mockFetch(ok({ expires_at: 0 }));
  const r = await run();
  assert.equal(r.accessToken, USER_TOKEN);
  assert.equal(r.id, '42');
  assert.ok(r.expiresIn > 9 * 365 * 24 * 3600);
});

test('success with an expiring token (60 days) converts expires_at to seconds remaining', async () => {
  const sixty = Math.floor(Date.now() / 1000) + 60 * 86400;
  mockFetch(ok({ expires_at: sixty }));
  const r = await run();
  assert.ok(Math.abs(r.expiresIn - 60 * 86400) < 10, 'expiresIn=' + r.expiresIn);
});

test('missing instagram_content_publish scope is refused (NotEnoughScopes)', async () => {
  mockFetch(ok({ scopes: ['instagram_basic'] }));
  await assert.rejects(run, (e) => e.constructor.name === 'NotEnoughScopes');
});

test('debug_token HTTP error returns a sanitised message (no secret, token or URL)', async () => {
  mockFetch([
    ok()[0],
    { path: '/debug_token', reply: () => json(400, { error: { code: 100, message: 'Unsupported post request.' } }) },
  ]);
  const r = await run();
  assert.equal(typeof r, 'string');
  assert.match(r, /Meta Graph API error \(400, code 100\)/);
  for (const s of [APP_SECRET, USER_TOKEN, CODE, 'graph.facebook.com', 'input_token']) assert.ok(!r.includes(s), 'leaked ' + s);
});

test('debug_token is_valid:false (HTTP 200) is rejected', async () => {
  mockFetch(ok({ is_valid: false, scopes: [], error: { code: 190, message: 'Invalid OAuth access token' } }));
  const r = await run();
  assert.equal(r, 'Meta reports that the Instagram token is not valid');
});

test('token exchange failure is returned sanitised and stops before debug_token', async () => {
  const calls = mockFetch([
    { path: '/oauth/access_token', reply: () => json(400, { error: { code: 100, message: 'Invalid verification code format.' } }) },
  ]);
  const r = await run();
  assert.match(r, /code 100/);
  assert.equal(calls.length, 1);
  for (const s of [APP_SECRET, CODE]) assert.ok(!dump(r).includes(s));
});

test('missing access_token in the exchange response is reported', async () => {
  mockFetch([{ path: '/oauth/access_token', reply: () => json(200, {}) }]);
  assert.equal(await run(), 'Meta did not return an access token');
});

test('redirects are refused and requests time out (hardening preserved)', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(init);
    return json(200, { access_token: USER_TOKEN, data: { is_valid: true, scopes: goodScopes, expires_at: 0, user_id: '1' }, id: '1', name: 'n' });
  };
  await run();
  for (const init of calls) {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
  }
});
