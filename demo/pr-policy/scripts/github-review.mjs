import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateFiles, formatReport, validatePolicy } from './policy.mjs';

const marker = '<!-- pr-policy-demo-report:v1 -->';
const shaPattern = /^[a-f0-9]{40}$/i;

export function createApiClient({ token, apiUrl = 'https://api.github.com', allowLocalTestServer = false }) {
  const base = new URL(apiUrl);
  const localTest = allowLocalTestServer && base.hostname === '127.0.0.1' && base.protocol === 'http:';
  if (!localTest && base.origin !== 'https://api.github.com') throw new Error('Only the GitHub.com API is supported by this demo.');
  if (!token) throw new Error('A GitHub token is required.');
  return async (method, path, body) => {
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith('/repos/')) throw new Error('Unexpected API request destination.');
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${url.pathname} returned HTTP ${response.status}.`);
    return response.status === 204 ? null : response.json();
  };
}

export async function reviewPullRequest({ event, policy, request, policyRef, runUrl }) {
  validatePolicy(policy);
  const repository = event.repository?.full_name;
  const pullNumber = event.pull_request?.number;
  const expectedHead = event.pull_request?.head?.sha;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !Number.isSafeInteger(pullNumber) || pullNumber < 1 || !shaPattern.test(expectedHead ?? '')) {
    throw new Error('Invalid pull request event identity.');
  }
  if (event.pull_request.base?.ref !== policy.targetBranch) return { decision: 'OUT_OF_SCOPE', report: 'This demo does not review PRs targeting other branches.', published: false };
  const prefix = `/repos/${repository}`;
  const pullPath = `${prefix}/pulls/${pullNumber}`;
  const current = await request('GET', pullPath);
  if (current.state !== 'open' || current.head?.sha !== expectedHead) return { decision: 'STALE', report: 'This event no longer matches the open PR revision. No result was published.', published: false };
  const expectedBase = current.base?.sha;
  if (!shaPattern.test(expectedBase ?? '') || current.base?.repo?.full_name !== repository || current.base?.ref !== policy.targetBranch) {
    throw new Error('The PR no longer targets the configured demo branch.');
  }
  const status = (state, description) => request('POST', `${prefix}/statuses/${expectedHead}`, {
    state, context: policy.checkName, description, target_url: runUrl,
  });
  await status('pending', 'Checking the trusted no-Python and no-UI policy.');

  try {
    const total = current.changed_files;
    if (!Number.isSafeInteger(total) || total < 1 || total > 3000) throw new Error('The changed-file list cannot be completely verified within the API limit.');
    const files = [];
    for (let page = 1; files.length < total && page <= 30; page += 1) {
      const batch = await request('GET', `${pullPath}/files?per_page=100&page=${page}`);
      if (!Array.isArray(batch) || !batch.length || batch.length > 100) throw new Error('Incomplete or invalid changed-file response.');
      files.push(...batch);
    }
    if (files.length !== total) throw new Error('Changed-file count mismatch. Refusing a partial review.');
    const result = evaluateFiles(files, policy);
    const report = marker + '\n' + formatReport(result, { commit: expectedHead, policyRef });
    const recheck = await request('GET', pullPath);
    if (recheck.state !== 'open' || recheck.head?.sha !== expectedHead || recheck.base?.sha !== expectedBase || recheck.base?.ref !== policy.targetBranch || recheck.changed_files !== total) {
      await status('error', 'PR changed during review. A fresh review is required.');
      return { decision: 'STALE', report: 'PR changed during review. No passing result or report was published.', published: false };
    }
    const commentPath = `${prefix}/issues/${pullNumber}/comments`;
    let previousComment;
    for (let page = 1; page <= 30; page += 1) {
      const comments = await request('GET', `${commentPath}?per_page=100&page=${page}`);
      if (!Array.isArray(comments)) throw new Error('Invalid PR comment response.');
      previousComment = comments.find(comment => comment.user?.login === 'github-actions[bot]' && comment.user?.type === 'Bot' && comment.body?.startsWith(marker)) ?? previousComment;
      if (comments.length < 100 || previousComment) break;
      if (page === 30) throw new Error('Unable to safely locate the previous report within the comment limit.');
    }
    const commentBody = report.length <= 60000 ? report : `${report.slice(0, 58000)}\n\nReport display truncated. All ${result.changedFiles} files were evaluated; ${result.violations.length} violations block this PR. See the workflow summary.`;
    if (previousComment) {
      if (!Number.isSafeInteger(previousComment.id)) throw new Error('Invalid existing report ID.');
      await request('PATCH', `${prefix}/issues/comments/${previousComment.id}`, { body: commentBody });
    } else {
      await request('POST', commentPath, { body: commentBody });
    }
    await status(result.decision === 'PASS' ? 'success' : 'failure', result.decision === 'PASS' ? 'Declared file policy passed. Human review still applies.' : `Rejected: ${result.violations.length} policy violation(s). Read the PR report.`);
    return { ...result, report, published: true };
  } catch (error) {
    await status('error', 'Review could not finish. Merge must remain blocked.');
    throw error;
  }
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'pull_request_target') {
    throw new Error('This publisher runs only in the configured GitHub workflow. Use npm run demo for the offline rehearsal.');
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (event.repository?.full_name !== process.env.GITHUB_REPOSITORY) throw new Error('Repository context mismatch.');
  const policy = JSON.parse(readFileSync(new URL('../policy.json', import.meta.url), 'utf8'));
  const runUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const result = await reviewPullRequest({ event, policy, request: createApiClient({ token: process.env.GITHUB_TOKEN }), policyRef: process.env.GITHUB_SHA, runUrl });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.report);
  console.log(`PR policy decision: ${result.decision}. Published: ${result.published}.`);
  process.exitCode = ['PASS', 'STALE', 'OUT_OF_SCOPE'].includes(result.decision) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}