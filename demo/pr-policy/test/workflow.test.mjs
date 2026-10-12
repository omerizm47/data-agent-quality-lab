import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { calculateExposure } from '../src/backend/exposure.mjs';

const workflow = parse(readFileSync(new URL('../../../.github/workflows/pr-policy-demo.yml', import.meta.url), 'utf8'));
const ruleset = JSON.parse(readFileSync(new URL('../ruleset.json', import.meta.url), 'utf8'));

test('privileged reviewer checks out only trusted code and runs no PR-supplied package scripts', () => {
  assert.deepEqual(Object.keys(workflow.on), ['pull_request_target']);
  assert.deepEqual(workflow.on.pull_request_target.branches, ['demo/pr-policy']);
  assert.ok(workflow.on.pull_request_target.types.includes('synchronize'));
  assert.ok(!workflow.on.pull_request_target.paths);
  const steps = workflow.jobs['policy-review'].steps;
  assert.equal(steps[0].with.ref, '${{ github.sha }}');
  assert.equal(steps[0].with['persist-credentials'], false);
  assert.deepEqual(steps.filter(step => step.run).map(step => step.run), ['node demo/pr-policy/scripts/github-review.mjs']);
  assert.ok(steps.filter(step => step.uses).every(step => /@[a-f0-9]{40}$/.test(step.uses)));
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.permissions['pull-requests'], 'write');
  assert.equal(workflow.permissions.statuses, 'write');
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
});

test('ruleset requires the exact status from GitHub Actions without bypass actors', () => {
  assert.equal(ruleset.enforcement, 'active');
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.deepEqual(ruleset.conditions.ref_name.include, ['refs/heads/demo/pr-policy']);
  const checkRule = ruleset.rules.find(rule => rule.type === 'required_status_checks');
  assert.deepEqual(checkRule.parameters.required_status_checks, [{ context: 'PR policy demo / file rules', integration_id: 15368 }]);
  assert.equal(checkRule.parameters.strict_required_status_checks_policy, true);
});

test('backend example retains gross exposure despite offsetting positions', () => {
  assert.deepEqual(calculateExposure([
    { actualMWh: 100, nominatedMWh: 120, priceEurPerMWh: 120 },
    { actualMWh: 120, nominatedMWh: 100, priceEurPerMWh: 120 },
  ]), { netExposureEur: 0, grossExposureEur: 4800 });
});