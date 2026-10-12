import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateFiles, formatReport } from './policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(readFileSync(join(root, 'policy.json'), 'utf8'));
const scenarios = JSON.parse(readFileSync(join(root, 'demo', 'scenarios.json'), 'utf8'));
const selected = process.argv[2] ?? 'all';
const selection = selected === 'all' ? scenarios : scenarios.filter(scenario => scenario.id === selected);
if (!selection.length) throw new Error('Choose ui, python, backend, or all.');
const output = join(root, 'review-output');
mkdirSync(output, { recursive: true });
console.log('PR POLICY REHEARSAL | isolated demo/pr-policy target branch');
console.log('Local scenarios only. No repository, PR, comment, vote, or status is created.\n');
for (const scenario of selection) {
  const result = evaluateFiles(scenario.files, policy);
  assert.equal(result.decision, scenario.expectedDecision);
  const report = formatReport(result, { commit: `scenario/${scenario.id}`, policyRef: 'demo/pr-policy/policy.json' });
  writeFileSync(join(output, `${scenario.id}.md`), report);
  writeFileSync(join(output, `${scenario.id}.json`), JSON.stringify({ scenario: scenario.id, ...result }, null, 2) + '\n');
  console.log(`${scenario.title}: ${result.decision}`);
  for (const violation of result.violations) console.log(`  ${violation.ruleId} | ${violation.path}\n  ${violation.reason}\n  Fix: ${violation.remediation}`);
  console.log(`  Report: review-output/${scenario.id}.md\n`);
}
console.log('Rehearsal expectations passed. GitHub-hosted enforcement still requires publishing and a required status rule.');