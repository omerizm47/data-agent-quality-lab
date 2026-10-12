import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateFiles, formatReport } from '../scripts/policy.mjs';

const policy = JSON.parse(readFileSync(new URL('../policy.json', import.meta.url), 'utf8'));
const change = (filename, status = 'added', previous_filename) => ({ filename: `demo/pr-policy/${filename}`, status, ...(previous_filename ? { previous_filename: `demo/pr-policy/${previous_filename}` } : {}) });

test('a UI pull request is blocked and receives an actionable report', () => {
  const result = evaluateFiles([change('ui/dashboard.html')], policy);
  assert.equal(result.decision, 'BLOCK');
  assert.equal(result.violations[0].ruleId, 'DEMO-002');
  const report = formatReport(result);
  assert.match(report, /ui\/dashboard.html/);
  assert.match(report, /No UI changes/);
  assert.match(report, /appropriate UI workflow/);
});

test('Python source, notebooks, and manifests are blocked', () => {
  for (const path of ['automation/job.py', 'src/backend/worker.PY', 'analysis.ipynb', 'pyproject.toml', 'requirements-dev.txt', 'uv.lock']) {
    assert.ok(evaluateFiles([change(path)], policy).violations.some(violation => violation.ruleId === 'DEMO-001'), path);
  }
});

test('UI files and known directories are blocked regardless of case or location', () => {
  for (const path of ['src/backend/page.tsx', 'src/backend/style.css', 'Frontend/config.json', 'src/components/service.ts', 'docs/mockup.svg', 'src/backend/widget.vue']) {
    assert.ok(evaluateFiles([change(path)], policy).violations.some(violation => violation.ruleId === 'DEMO-002'), path);
  }
});

test('supported backend and documentation changes pass the file policy', () => {
  const result = evaluateFiles([change('src/backend/exposure.mjs', 'modified'), change('test/backend/exposure.test.mjs'), change('docs/api.md')], policy);
  assert.equal(result.decision, 'PASS');
  assert.equal(result.violations.length, 0);
});

test('unknown change scopes fail closed', () => {
  assert.equal(evaluateFiles([change('misc/service.js')], policy).violations[0].ruleId, 'DEMO-004');
});

test('renaming a prohibited file does not evade policy', () => {
  const result = evaluateFiles([change('src/backend/exposure.mjs', 'renamed', 'ui/exposure.js')], policy);
  assert.equal(result.decision, 'BLOCK');
  assert.ok(result.violations.some(violation => violation.ruleId === 'DEMO-002'));
  assert.match(formatReport(result), /previous path: demo\/pr-policy\/ui\/exposure.js/);
});

test('deletions still count as changes to a prohibited area', () => {
  assert.equal(evaluateFiles([change('ui/page.html', 'removed')], policy).decision, 'BLOCK');
});

test('PR policy and reviewer edits are blocked', () => {
  for (const path of ['.github/review-policy.json', 'scripts/policy.mjs', '.github/workflows/pr-policy.yml']) {
    assert.ok(evaluateFiles([change(path)], policy).violations.some(violation => violation.ruleId === 'DEMO-003'));
  }
});

test('malformed, incomplete, and duplicate lists are not accepted', () => {
  for (const files of [[], [change('../file.py')], [change('src\\backend\\file.mjs')], [change('src/backend/file.mjs', 'mystery')], [change('src/backend/file.mjs', 'renamed')], [change('src/backend/file.mjs'), change('src/backend/file.mjs')]]) {
    assert.throws(() => evaluateFiles(files, policy));
  }
});

test('untrusted filenames cannot inject report markup or mentions', () => {
  const report = formatReport(evaluateFiles([change('ui/<img>@everyone|`name`.html')], policy));
  assert.doesNotMatch(report, /<img>|@everyone/);
  assert.match(report, /&lt;img&gt;&#64;everyone&#124;&#96;name&#96;/);
});