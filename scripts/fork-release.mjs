#!/usr/bin/env node
// Fork-only publication. Source import bindings stay unchanged; npm aliases
// resolve the published workspace graph from the fork's GitHub Packages scope.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getReleasePackages } from './release-package-map.mjs';
import { materializePublishManifest, prepareBundledPackage } from './prepare-bundled-package.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const registry = 'https://npm.pkg.github.com';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const run = (command, args, cwd = repo) => execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const digest = (path, algorithm, encoding = 'hex') => createHash(algorithm).update(readFileSync(path)).digest(encoding);

export function releaseVersion(date, patch) {
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(date).toISOString().slice(0, 10), date, 'Invalid UTC release date');
  assert.ok(Number.isSafeInteger(patch) && patch >= 0);
  const [year, month, day] = date.split('-');
  return `${year}.${Number(month)}${day}.${patch}`;
}

function forkName(name, owner) {
  assert.match(owner, /^[a-z0-9][a-z0-9-]*$/);
  assert.notEqual(owner, 'paperclipai', 'Fork releases must not target the upstream owner');
  assert.ok(name === 'paperclipai' || name.startsWith('@paperclipai/'));
  return `@${owner}/${name.replace('@paperclipai/', '')}`;
}

export function forkManifest(source, names, owner, version, repository) {
  assert.equal(repository.split('/')[0], owner);
  assert.match(version, /^\d{4}\.\d{3,4}\.\d+$/);
  const pkg = materializePublishManifest(structuredClone(source));
  pkg.name = forkName(source.name, owner);
  pkg.version = version;
  delete pkg.devDependencies;
  delete pkg.private;
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      if (names.has(name)) pkg[section][name] = `npm:${forkName(name, owner)}@${version}`;
      else assert.ok(!name.startsWith('@paperclipai/') && !/^(workspace|file|link):/.test(spec), `unpublished internal dependency: ${name}@${spec}`);
    }
  }
  for (const hook of ['prepack', 'postpack', 'prepare', 'prepublishOnly']) {
    if (pkg.scripts) delete pkg.scripts[hook];
  }
  pkg.repository = { type: 'git', url: `git+https://github.com/${repository}.git`, directory: source.repository?.directory };
  pkg.publishConfig = { registry };
  return pkg;
}

async function stage(directory, owner, version, repository) {
  assert.ok(!existsSync(directory), 'Use a fresh output directory');
  mkdirSync(directory, { recursive: true });
  const packages = getReleasePackages();
  const names = new Set(packages.map(pkg => pkg.name));
  const work = mkdtempSync(join(tmpdir(), 'paperclip-fork-stage-'));
  const archives = [];
  try {
    for (const [index, entry] of packages.entries()) {
      console.log(`Staging ${entry.name}`);
      const source = join(repo, entry.dir), target = join(work, `package-${index}`), packed = join(work, `pack-${index}`);
      mkdirSync(packed);
      if ((entry.pkg.bundleDependencies ?? entry.pkg.bundledDependencies ?? []).length) {
        prepareBundledPackage(source, target);
      } else {
        // Preserve the owning package's prepack transformations (UI, plugins,
        // Hermes) instead of duplicating their publication contracts here.
        run('pnpm', ['pack', '--pack-destination', packed], source);
        const files = readdirSync(packed).filter(file => file.endsWith('.tgz'));
        assert.equal(files.length, 1);
        run('tar', ['-xzf', join(packed, files[0]), '-C', packed]);
        run('mv', [join(packed, 'package'), target]);
      }
      const path = join(target, 'package.json');
      const manifest = forkManifest(json(path), names, owner, version, repository);
      writeJson(path, manifest);
      const result = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], target));
      assert.equal(result.length, 1);
      const file = result[0].filename, archive = join(directory, file);
      archives.push({ originalName: entry.name, name: manifest.name, version, file,
        sha256: digest(archive, 'sha256'), integrity: `sha512-${digest(archive, 'sha512', 'base64')}` });
    }
    writeJson(join(directory, 'packages.json'), { repository, source: run('git', ['rev-parse', 'HEAD']).trim(), version, archives });
    writeFileSync(join(directory, 'SHA256SUMS'), archives.map(entry => `${entry.sha256}  ${entry.file}\n`).join(''));
  } finally { rmSync(work, { recursive: true, force: true }); }
}

async function publish(directory) {
  const manifest = json(join(directory, 'packages.json'));
  assert.equal(manifest.repository, process.env.GITHUB_REPOSITORY);
  for (const entry of manifest.archives) {
    assert.equal(entry.name, forkName(entry.originalName, manifest.repository.split('/')[0]));
    assert.equal(digest(join(directory, entry.file), 'sha256'), entry.sha256);
    run('npm', ['publish', join(directory, entry.file), '--ignore-scripts', '--registry', registry, '--tag', 'latest']);
  }
}

async function verify(directory) {
  const manifest = json(join(directory, 'packages.json'));
  const work = mkdtempSync(join(tmpdir(), 'paperclip-fork-verify-'));
  const verified = [];
  try {
    for (const entry of manifest.archives) {
      const spec = `${entry.name}@${entry.version}`;
      const metadata = JSON.parse(run('npm', ['view', spec, '--json', '--registry', registry]));
      assert.equal(metadata.version, manifest.version);
      assert.equal(metadata['dist-tags'].latest, manifest.version);
      assert.equal(metadata.dist.integrity, entry.integrity);
      const result = JSON.parse(run('npm', ['pack', spec, '--ignore-scripts', '--json', '--pack-destination', work, '--registry', registry]));
      assert.equal(digest(join(work, result[0].filename), 'sha256'), entry.sha256, `Registry bytes differ: ${spec}`);
      verified.push(spec);
    }
    writeJson(join(directory, 'registry-verification.json'), { source: manifest.source, registry, verified });
  } finally { rmSync(work, { recursive: true, force: true }); }
}

async function smoke(directory) {
  const manifest = json(join(directory, 'packages.json'));
  const cli = manifest.archives.find(entry => entry.originalName === 'paperclipai');
  const work = mkdtempSync(join(tmpdir(), 'paperclip-fork-smoke-'));
  let child;
  try {
    writeJson(join(work, 'package.json'), { private: true, type: 'module' });
    run('npm', ['install', '--omit=dev', '--ignore-scripts', `${cli.name}@${manifest.version}`], work);
    run('npm', ['rebuild', '--dangerously-allow-all-scripts'], work);
    const versionOutput = run('node', [join(work, 'node_modules', cli.name, 'dist/index.js'), '--version'], work).trim();
    assert.equal(versionOutput, manifest.version);
    const server = join(work, 'node_modules/@paperclipai/server/dist/index.js');
    assert.ok(existsSync(server), 'CLI must install the fork server under its original import binding');
    child = spawn(process.execPath, [server], { cwd: work, env: { ...process.env,
      PAPERCLIP_HOME: join(work, 'home'), PORT: '3199', SERVE_UI: 'true',
      PAPERCLIP_DEPLOYMENT_MODE: 'local_trusted', DATABASE_URL: '', PAPERCLIP_MIGRATION_PROMPT: 'never', PAPERCLIP_MIGRATION_AUTO_APPLY: 'true' }, stdio: 'inherit' });
    let health;
    for (let attempt = 0; attempt < 120; attempt++) {
      assert.equal(child.exitCode, null, 'Installed server exited during smoke test');
      try {
        const response = await fetch('http://127.0.0.1:3199/api/health');
        if (response.ok) { health = await response.json(); if (health.status === 'ok' && health.bootstrapStatus === 'ready') break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(health?.status, 'ok');
    assert.equal(health?.bootstrapStatus, 'ready');
    const response = await fetch('http://127.0.0.1:3199/');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<html/);
    writeJson(join(directory, 'package-smoke.json'), { source: manifest.source, version: versionOutput, health, uiStatus: response.status });
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, owner, version, repository] = process.argv.slice(2);
  if (command === 'version') {
    const date = directory || new Date().toISOString().slice(0, 10);
    const prefix = releaseVersion(date, 0).replace(/0$/, '');
    const tags = run('git', ['tag', '--list', `v${prefix}*`]).trim().split('\n');
    let patch = 0;
    while (tags.includes(`v${releaseVersion(date, patch)}`)) patch++;
    const value = releaseVersion(date, patch);
    console.log(value);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${value}\n`);
  } else if (command === 'stage') await stage(resolve(directory), owner, version, repository);
  else if (command === 'publish') await publish(resolve(directory));
  else if (command === 'verify') await verify(resolve(directory));
  else if (command === 'smoke') await smoke(resolve(directory));
  else throw new Error('Usage: fork-release.mjs version [DATE] | stage DIRECTORY OWNER VERSION REPOSITORY | publish|verify|smoke DIRECTORY');
}
