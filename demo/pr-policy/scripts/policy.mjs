import { posix } from 'node:path';

const changeStatuses = new Set(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']);

function normalizePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('The changed-file list contains an invalid repository path.');
  }
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('The changed-file list contains an invalid repository path.');
  }
  return value.normalize('NFKC').toLowerCase();
}

export function validatePolicy(policy) {
  if (policy?.version !== 1 || policy.targetBranch !== 'demo/pr-policy' || typeof policy.checkName !== 'string' || !policy.checkName.trim() || !Array.isArray(policy.rules) || !policy.rules.length || !Array.isArray(policy.allowedChanges) || !policy.allowedChanges.length) {
    throw new Error('Invalid review policy. Review must remain blocked.');
  }
  const ids = new Set();
  for (const rule of policy.rules) {
    if (typeof rule.id !== 'string' || !rule.id || ids.has(rule.id) || !['name', 'reason', 'remediation'].every(key => typeof rule[key] === 'string' && rule[key].trim())) {
      throw new Error('Invalid or duplicate review rule.');
    }
    ids.add(rule.id);
    for (const key of ['extensions', 'fileNames', 'fileNamePatterns', 'pathSegments']) {
      if (!Array.isArray(rule[key]) || !rule[key].every(value => typeof value === 'string' && value.length > 0)) throw new Error(`Invalid rule field: ${key}.`);
    }
    for (const pattern of rule.fileNamePatterns) new RegExp(pattern, 'i');
  }
  for (const allowed of policy.allowedChanges) {
    if (typeof allowed.prefix !== 'string' || !allowed.prefix.endsWith('/') || !Array.isArray(allowed.extensions) || !allowed.extensions.length || !allowed.extensions.every(extension => typeof extension === 'string' && extension.startsWith('.'))) {
      throw new Error('Invalid allowed change scope.');
    }
    normalizePath(allowed.prefix.slice(0, -1));
  }
  return policy;
}

export function evaluateFiles(files, policy) {
  validatePolicy(policy);
  if (!Array.isArray(files) || !files.length) throw new Error('No complete changed-file list was supplied.');
  const violations = [];
  const seen = new Set();
  for (const file of files) {
    if (!changeStatuses.has(file.status)) throw new Error('Unknown changed-file status.');
    const paths = [file.filename];
    if (file.status === 'renamed') {
      if (!file.previous_filename) throw new Error('A renamed file is missing its original path.');
      paths.push(file.previous_filename);
    }
    if (seen.has(file.filename)) throw new Error('Duplicate entries in the changed-file list.');
    seen.add(file.filename);
    const matchedRules = new Map();
    let outsideScope = false;
    for (const originalPath of paths) {
      const path = normalizePath(originalPath);
      const segments = path.split('/');
      const filename = segments.at(-1);
      const extension = posix.extname(path);
      let blockedPath = false;
      for (const rule of policy.rules) {
        const matches = rule.extensions.includes(extension) || rule.fileNames.includes(filename) ||
          rule.pathSegments.some(segment => segments.includes(segment)) ||
          rule.fileNamePatterns.some(pattern => new RegExp(pattern, 'i').test(filename));
        if (matches) {
          blockedPath = true;
          const match = matchedRules.get(rule.id) ?? { rule, matchedPaths: [] };
          match.matchedPaths.push(originalPath);
          matchedRules.set(rule.id, match);
        }
      }
      if (!blockedPath && !policy.allowedChanges.some(allowed => path.startsWith(allowed.prefix) && allowed.extensions.includes(extension))) outsideScope = true;
    }
    for (const { rule, matchedPaths } of matchedRules.values()) {
      violations.push({ ruleId: rule.id, ruleName: rule.name, path: file.filename, status: file.status, matchedPaths, reason: rule.reason, remediation: rule.remediation });
    }
    if (outsideScope) violations.push({ ruleId: 'DEMO-004', ruleName: 'Unapproved change scope', path: file.filename, status: file.status, matchedPaths: paths, reason: 'This change is outside the explicitly allowed demo backend, backend-test, and documentation paths.', remediation: 'Move the change to an approved demo scope or use the normal main-branch workflow. A PR description cannot grant an exception.' });
  }
  return { decision: violations.length ? 'BLOCK' : 'PASS', changedFiles: files.length, violations };
}

function escapeText(value) {
  return String(value).replace(/[&<>|`@\r\n]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '`': '&#96;', '@': '&#64;', '\r': ' ', '\n': ' ' })[character]);
}

export function formatReport(result, { commit = 'local rehearsal', policyRef = 'trusted local policy' } = {}) {
  const lines = [
    `## PR policy demo: ${result.decision}`,
    '',
    `Reviewed revision: <code>${escapeText(commit)}</code>`,
    `Policy source: <code>${escapeText(policyRef)}</code>`,
    `Changed files checked: ${result.changedFiles}`,
    '',
  ];
  if (result.violations.length) {
    lines.push(`**Rejected by policy: ${result.violations.length} violation(s).**`, '', '| Rule | File | Why this is blocked | Required change |', '| --- | --- | --- | --- |');
    for (const violation of result.violations) {
      const rename = violation.matchedPaths.filter(path => path !== violation.path).map(path => ` (also checks previous path: ${escapeText(path)})`).join('');
      lines.push(`| ${escapeText(violation.ruleId)}: ${escapeText(violation.ruleName)} | <code>${escapeText(violation.path)}</code>${rename} | ${escapeText(violation.reason)} | ${escapeText(violation.remediation)} |`);
    }
  } else {
    lines.push('**The declared file policy passed.** This is not an approval of correctness, security, or all other review requirements.');
  }
  lines.push('', 'This report is generated by deterministic policy automation, not the native GitHub Copilot reviewer. Copilot can explain findings but cannot override this policy.', '', 'Merge blocking requires the PR policy demo / file rules status on demo/pr-policy only. Normal main-branch PRs are unaffected. The PR is not automatically closed or merged.', '', 'Scope: explicit file paths, extensions, and names, including renames and deletions. This is not a universal detector of Python or UI code disguised inside otherwise permitted files.');
  return lines.join('\n') + '\n';
}