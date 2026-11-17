import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const workflows = [
  '.github/workflows/refresh-lockfile.yml',
  '.github/workflows/pr-trusted.yml',
  '.github/workflows/docker.yml',
];

// Bun's equivalent of pnpm's `--resolution-only` is `--lockfile-only`, which
// writes the lockfile without installing (scripts/typecheck-test-programs.mjs
// documents the same mapping). Bun 1.4.4 accepts pnpm's `--resolution-only` and
// ignores it, so a repair line carrying it performs a full install instead of
// resolving. `--no-save` then suppresses the lockfile write, which turns the
// whole repair into a silent no-op.
test('lockfile repair workflows resolve dependencies instead of updating metadata only', async () => {
  for (const workflow of workflows) {
    const contents = await readFile(workflow, 'utf8');
    const repairCommands = contents
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.includes('bun install') && line.includes('--no-frozen-lockfile'));

    assert.ok(repairCommands.length > 0, `${workflow} must contain a lockfile repair command`);
    for (const { line, number } of repairCommands) {
      const where = `${workflow}:${number}`;
      assert.match(line, /--lockfile-only/, `${where} must resolve the lockfile without installing`);
      assert.match(line, /--ignore-scripts/, `${where} must run without lifecycle scripts`);
      assert.doesNotMatch(line, /--resolution-only/, `${where} must use Bun's --lockfile-only, not pnpm's ignored --resolution-only`);
      assert.doesNotMatch(line, /--no-save/, `${where} must write the resolved lockfile, so --no-save would make it a no-op`);
    }
  }
});
