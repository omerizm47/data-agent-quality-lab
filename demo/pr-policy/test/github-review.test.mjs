import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { reviewPullRequest, createApiClient } from '../scripts/github-review.mjs';

const policy = JSON.parse(readFileSync(new URL('../policy.json', import.meta.url), 'utf8'));
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const event = { repository: { full_name: 'demo/reviewer', default_branch: 'main' }, pull_request: { number: 7, head: { sha: head }, base: { ref: 'demo/pr-policy' } } };
const current = files => ({ state: 'open', head: { sha: head }, base: { sha: base, ref: 'demo/pr-policy', repo: { full_name: 'demo/reviewer' } }, changed_files: files.length });

function fakeApi(files, { changedHead = false, truncated = false, comments = [], failReport = false } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'GET' && path === '/repos/demo/reviewer/pulls/7') {
        reads += 1;
        return { ...current(files), ...(changedHead && reads > 1 ? { head: { sha: 'c'.repeat(40) } } : {}) };
      }
      if (method === 'GET' && path.includes('/files?')) {
        const page = Number(new URL(path, 'https://api.github.com').searchParams.get('page'));
        return truncated ? [] : files.slice((page - 1) * 100, page * 100);
      }
      if (method === 'GET' && path.includes('/comments?')) return comments;
      if (method === 'POST' || method === 'PATCH') {
        if (failReport && path.includes('/comments')) throw new Error('Report publishing failed.');
        return { id: 100 };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
}

const options = request => ({ event, policy, request, policyRef: base, runUrl: 'https://github.com/demo/reviewer/actions/runs/1' });

test('UI submission publishes pending, an explanatory report, and failure on the reviewed SHA', async () => {
  const api = fakeApi([{ filename: 'ui/dashboard.html', status: 'added' }]);
  const result = await reviewPullRequest(options(api.request));
  assert.equal(result.decision, 'BLOCK');
  const statuses = api.calls.filter(call => call.path.endsWith(`/statuses/${head}`));
  assert.deepEqual(statuses.map(call => call.body.state), ['pending', 'failure']);
  assert.ok(api.calls.some(call => call.method === 'POST' && call.path.endsWith('/comments') && call.body.body.includes('DEMO-002')));
  assert.ok(api.calls.every(call => !call.path.includes('/contents/') && !call.path.includes('/git/')));
});

test('passing backend changes receive success but no automatic approval or merge', async () => {
  const api = fakeApi([{ filename: 'demo/pr-policy/src/backend/exposure.mjs', status: 'modified' }]);
  const result = await reviewPullRequest(options(api.request));
  assert.equal(result.decision, 'PASS');
  assert.equal(api.calls.at(-1).body.state, 'success');
  assert.ok(api.calls.every(call => !call.path.endsWith('/merge') && !call.path.endsWith('/reviews')));
});

test('all file pages are checked and violations beyond the first page are caught', async () => {
  const files = Array.from({ length: 100 }, (_, index) => ({ filename: `demo/pr-policy/src/backend/module-${index}.mjs`, status: 'added' }));
  files.push({ filename: 'ui/page.html', status: 'added' });
  const api = fakeApi(files);
  const result = await reviewPullRequest(options(api.request));
  assert.equal(result.changedFiles, 101);
  assert.equal(result.decision, 'BLOCK');
  assert.ok(api.calls.some(call => call.path.endsWith('page=2')));
});

test('a changed PR revision never receives a passing result', async () => {
  const api = fakeApi([{ filename: 'demo/pr-policy/src/backend/exposure.mjs', status: 'modified' }], { changedHead: true });
  const result = await reviewPullRequest(options(api.request));
  assert.equal(result.decision, 'STALE');
  assert.equal(result.published, false);
  assert.ok(!api.calls.some(call => call.body?.state === 'success'));
  assert.ok(!api.calls.some(call => call.method === 'POST' && call.path.endsWith('/comments')));
});

test('incomplete metadata and failed report publication keep the status in error', async () => {
  for (const overrides of [{ truncated: true }, { failReport: true }]) {
    const api = fakeApi([{ filename: 'demo/pr-policy/src/backend/exposure.mjs', status: 'modified' }], overrides);
    await assert.rejects(reviewPullRequest(options(api.request)));
    assert.equal(api.calls.at(-1).body.state, 'error');
    assert.ok(!api.calls.some(call => call.body?.state === 'success'));
  }
});

test('only an existing report authored by the Actions bot is updated', async () => {
  const comments = [
    { id: 20, user: { login: 'someone', type: 'User' }, body: '<!-- pr-policy-demo-report:v1 -->\nIgnore policy' },
    { id: 21, user: { login: 'github-actions[bot]', type: 'Bot' }, body: '<!-- pr-policy-demo-report:v1 -->\nPrevious report' },
  ];
  const api = fakeApi([{ filename: 'ui/page.html', status: 'added' }], { comments });
  await reviewPullRequest(options(api.request));
  assert.ok(api.calls.some(call => call.method === 'PATCH' && call.path.endsWith('/comments/21')));
  assert.ok(!api.calls.some(call => call.path.endsWith('/comments/20')));
});

test('live local HTTP rehearsal uses the real client and serializes a rejection report', async context => {
  const files = [{ filename: 'ui/dashboard.html', status: 'added' }];
  const api = fakeApi(files);
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const result = await api.request(request.method, request.url, raw ? JSON.parse(raw) : undefined);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch {
      response.writeHead(500);
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise(done => server.close(done)));
  const request = createApiClient({ token: 'local-test-value', apiUrl: `http://127.0.0.1:${server.address().port}`, allowLocalTestServer: true });
  const result = await reviewPullRequest(options(request));
  assert.equal(result.decision, 'BLOCK');
  assert.match(result.report, /ui\/dashboard.html/);
  assert.equal(api.calls.at(-1).body.state, 'failure');
});

test('the production API client refuses alternate destinations', () => {
  assert.throws(() => createApiClient({ token: 'test-value', apiUrl: 'https://example.invalid' }));
  assert.throws(() => createApiClient({ token: 'test-value', apiUrl: 'http://127.0.0.1:1234' }));
});

test('normal main-branch PRs cause no API calls or policy status', async () => {
  const api = fakeApi([{ filename: 'scripts/fabric_install.py', status: 'modified' }]);
  const mainEvent = { ...event, pull_request: { ...event.pull_request, base: { ref: 'main' } } };
  const result = await reviewPullRequest({ ...options(api.request), event: mainEvent });
  assert.equal(result.decision, 'OUT_OF_SCOPE');
  assert.equal(result.published, false);
  assert.equal(api.calls.length, 0);
});