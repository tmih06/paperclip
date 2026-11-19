import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startPackedRegistry, writePackedRegistryCatalog } from '../public-install-registry.mjs';
import { assertPublishedPackage, forkManifest, forkOwnerChecks, releaseVersion } from '../fork-release.mjs';
import { assertQualification, requiredQualificationJobs } from '../fork-release-qualification.mjs';

test('fork release installs its pinned Bun runtime before running Bun commands', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/fork-release.yml', import.meta.url), 'utf8');
  const plan = workflow.split('\n  verify:')[0];
  assert.match(plan, /uses: oven-sh\/setup-bun@[0-9a-f]{40} # v6[\s\S]*?bun-version: 1\.4\.4[\s\S]*?run: bun scripts\/fork-release\.mjs version/);
});

test('release dates use the existing UTC calendar version format', () => {
  assert.equal(releaseVersion('2026-11-14', 0), '2026.1114.0');
  assert.equal(releaseVersion('2026-03-08', 2), '2026.308.2');
  for (const date of ['2026-02-30', '1.0.0', '2026-3-08']) {
    assert.throws(() => releaseVersion(date, 0));
  }
  assert.throws(() => releaseVersion('2026-11-14', -1));
});

test('fork tarballs keep import bindings but resolve every internal edge from GitHub Packages', () => {
  const names = new Set(['paperclipai', '@paperclipai/server', '@paperclipai/shared']);
  const source = { name: 'paperclipai', version: '0.3.1', private: false,
    repository: { type: 'git', url: 'https://github.com/paperclipai/paperclip', directory: 'cli' },
    dependencies: { '@paperclipai/server': 'workspace:*', zod: '^4.0.0' },
    optionalDependencies: { '@paperclipai/shared': '0.3.1' },
    peerDependencies: { '@paperclipai/shared': 'workspace:^' },
    devDependencies: { typescript: '*' },
    publishConfig: { exports: { '.': './dist/index.js' }, access: 'public' } };
  const result = forkManifest(source, names, 'tmih06', '2026.1114.0', 'tmih06/paperclip');
  assert.equal(result.name, '@tmih06/paperclipai');
  assert.equal(result.version, '2026.1114.0');
  assert.equal(result.dependencies['@paperclipai/server'], 'npm:@tmih06/server@2026.1114.0');
  assert.equal(result.optionalDependencies['@paperclipai/shared'], 'npm:@tmih06/shared@2026.1114.0');
  assert.equal(result.peerDependencies['@paperclipai/shared'], 'npm:@tmih06/shared@2026.1114.0');
  assert.equal(result.dependencies.zod, '^4.0.0');
  assert.equal(result.devDependencies, undefined);
  assert.equal(result.publishConfig.registry, 'https://npm.pkg.github.com');
  assert.equal(result.repository.url, 'git+https://github.com/tmih06/paperclip.git');
  assert.deepEqual(result.exports, { '.': './dist/index.js' });
  assert.equal(source.dependencies['@paperclipai/server'], 'workspace:*');
});

test('a clean consumer resolves original import bindings exclusively through fork aliases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fork-release-test-'));
  const exec = promisify(execFile);
  let registry;
  try {
    const assets = join(root, 'assets');
    mkdirSync(assets);
    const names = new Set(['@paperclipai/server', '@paperclipai/shared']);
    for (const name of names) {
      const dir = join(root, name.split('/')[1]);
      mkdirSync(dir);
      const manifest = forkManifest({ name, version: '0.3.1', type: 'module', exports: './index.js',
        ...(name.endsWith('/server') ? { dependencies: { '@paperclipai/shared': 'workspace:*' } } : {}) },
      names, 'tmih06', '2026.1114.0', 'tmih06/paperclip');
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
      writeFileSync(join(dir, 'index.js'), name.endsWith('/shared') ? 'export default 42;' : 'export { default } from "@paperclipai/shared";');
      await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', assets], { cwd: dir });
    }
    await writePackedRegistryCatalog(assets);
    registry = await startPackedRegistry(assets);
    const consumer = join(root, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', registry.url,
      '--replace-registry-host=never', '@tmih06/server@2026.1114.0'], { cwd: consumer });
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', 'import value from "@tmih06/server";console.log(value)'], { cwd: consumer });
    assert.equal(stdout.trim(), '42');
  } finally {
    if (registry) await registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a resumed publish accepts only the exact immutable package identity and bytes', () => {
  const entry = { name: '@tmih06/server', version: '2026.1114.0', integrity: 'sha512-qualified' };
  const metadata = { name: entry.name, version: entry.version, dist: { integrity: entry.integrity } };
  assert.doesNotThrow(() => assertPublishedPackage(entry, metadata));
  for (const change of [{ name: '@paperclipai/server' }, { version: '2026.1114.1' }, { dist: { integrity: 'sha512-other' } }]) {
    assert.throws(() => assertPublishedPackage(entry, { ...metadata, ...change }));
  }
});

test('fork ownership checks keep import bindings and reject a substituted owner', async () => {
  const source = `import x from "@paperclipai/server"; const path = "/node_modules/@paperclipai/server/dist";
const SERVER_PACKAGE_NAME = "@paperclipai/server";
if (owner.name === "@paperclipai/server") {};
if (value.name !== "@paperclipai/server") {};
if (!["@paperclipai/paperclip-runner", "@paperclipai/server"].includes(owner.name)) throw Error();`;
  const rewritten = forkOwnerChecks(source, 'tmih06');
  assert.match(rewritten, /import x from "@paperclipai\/server"/);
  assert.match(rewritten, /node_modules\/@paperclipai\/server/);
  assert.match(rewritten, /SERVER_PACKAGE_NAME = "@tmih06\/server"/);
  assert.match(rewritten, /owner.name === "@tmih06\/server"/);
  assert.match(rewritten, /value.name !== "@tmih06\/server"/);
  const root = mkdtempSync(join(tmpdir(), 'fork-owner-'));
  try {
    const dir = join(root, 'dist/vendor/paperclip-runner/drivers/acpx');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'installation-integrity.js');
    writeFileSync(file, '// owned verifier');
    const authority = join(dir, 'authority.ts');
    // Bun loads the TypeScript source directly, so the test exercises the real
    // published transformation instead of a separately stripped copy.
    const code = readFileSync(new URL('../../packages/paperclip-runner/src/drivers/acpx/installed-provider-authority.ts', import.meta.url), 'utf8');
    writeFileSync(authority, forkOwnerChecks(code, 'tmih06'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@tmih06/server', type: 'module' }));
    const { resolveInstalledProviderAuthority } = await import(pathToFileURL(authority).href);
    assert.deepEqual(resolveInstalledProviderAuthority(pathToFileURL(file).href), { root, manifest: join(root, 'package.json') });
    for (const name of ['@paperclipai/server', '@attacker/server', 'unrelated']) {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name, type: 'module' }));
      assert.throws(() => resolveInstalledProviderAuthority(pathToFileURL(file).href), /owning server/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resuming requires every source, native and image gate from the exact fork source', () => {
  const source = 'a'.repeat(40), repository = 'tmih06/paperclip';
  const run = { repository: { full_name: repository }, path: '.github/workflows/fork-release.yml',
    event: 'workflow_dispatch', head_sha: source, status: 'completed' };
  const jobs = requiredQualificationJobs.map(name => ({ name, conclusion: 'success' }));
  assert.doesNotThrow(() => assertQualification(run, jobs, source, repository));
  for (const job of jobs) {
    assert.throws(() => assertQualification(run, jobs.filter(value => value !== job), source, repository));
    for (const conclusion of ['failure', 'skipped', 'cancelled', null]) {
      assert.throws(() => assertQualification(run, jobs.map(value => value === job ? { ...job, conclusion } : value), source, repository));
    }
  }
  assert.throws(() => assertQualification({ ...run, head_sha: 'b'.repeat(40) }, jobs, source, repository));
  assert.throws(() => assertQualification({ ...run, repository: { full_name: 'other/paperclip' } }, jobs, source, repository));
  assert.throws(() => assertQualification(run, [...jobs, jobs[0]], source, repository));
});

test('staging refuses unpublished internal edges and upstream namespaces', () => {
  const pkg = { name: '@paperclipai/server', dependencies: { '@paperclipai/missing': 'workspace:*' } };
  assert.throws(() => forkManifest(pkg, new Set([pkg.name]), 'tmih06', '2026.1114.0', 'tmih06/paperclip'), /unpublished/);
  assert.throws(() => forkManifest({ name: 'paperclipai' }, new Set(['paperclipai']), 'paperclipai', '2026.1114.0', 'paperclipai/paperclip'));
});
