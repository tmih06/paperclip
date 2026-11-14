import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const requiredQualificationJobs = [
  'plan', 'verify / Typecheck', 'verify / Build', 'verify / Runner workflow eval scorer contract',
  'verify / Pre-release Runner chaos evals / Restart, replay, trace, and recovery faults',
  ...['protocol', 'rust', 'server-integration'].map(lane => `verify / Verify Paperclip Runner (${lane})`),
  ...Array.from({ length: 5 }, (_, i) => `verify / Serialized tests (${i + 1}/5)`),
  ...Array.from({ length: 10 }, (_, i) => `verify / General tests (server (${i + 1}/10))`),
  ...Array.from({ length: 3 }, (_, i) => `verify / General tests (chat (${i + 1}/3))`),
  ...['workspaces-a (1/2)', 'workspaces-a (2/2)', 'workspaces-b', 'workspaces-c'].map(group => `verify / General tests (${group})`),
  'native / Read exact-source daemon targets',
  ...['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'].map(target => `native / Release daemon (${target})`),
  'images (amd64, ubuntu-24.04)', 'images (arm64, ubuntu-24.04-arm)',
];

export function assertQualification(run, jobs, source, repository) {
  assert.equal(repository, 'tmih06/paperclip');
  assert.match(source, /^[a-f0-9]{40}$/);
  assert.equal(run.repository.full_name, repository);
  assert.equal(run.path, '.github/workflows/fork-release.yml');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_sha, source);
  assert.equal(run.status, 'completed');
  for (const name of requiredQualificationJobs) {
    const matching = jobs.filter(job => job.name === name);
    assert.equal(matching.length, 1, `Missing or ambiguous qualification: ${name}`);
    assert.equal(matching[0].conclusion, 'success', `Qualification did not pass: ${name}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [id, source, repository] = process.argv.slice(2);
  assert.match(id, /^\d+$/);
  const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const run = api(`repos/${repository}/actions/runs/${id}`);
  const jobs = [];
  for (let page = 1; ; page++) {
    const result = api(`repos/${repository}/actions/runs/${id}/jobs?filter=latest&per_page=100&page=${page}`);
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) break;
  }
  assertQualification(run, jobs, source, repository);
  console.log(`Verified ${requiredQualificationJobs.length} exact-source gates for ${source} in run ${id}`);
}
