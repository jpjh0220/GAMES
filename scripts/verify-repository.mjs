#!/usr/bin/env node

import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function expectFile(relativePath) {
  const path = join(root, relativePath);
  if (!(await exists(path))) failures.push(`Missing required file: ${relativePath}`);
}

async function expectAbsent(relativePath) {
  const path = join(root, relativePath);
  if (await exists(path)) failures.push(`Obsolete file must not remain in the authoritative overlay project: ${relativePath}`);
}

async function main() {
  const required = [
    'README.md',
    'LICENSE',
    'package.json',
    'package-lock.json',
    '.github/workflows/ci.yml',
    '.github/workflows/rs-sol-live.yml',
    'scripts/stage-and-build.mjs',
    'sol-live/sol-live.ts',
    'sol-live/agent-brain.ts',
    'sol-live/viewer.html',
    'sol-live/prerequisites.ts',
    'sol-live/goals.ts',
    'sol-live/economy.ts',
    'sol-live/skill-tree.ts',
    'sol-live/quest-system.ts',
    'sol-live/trade-inference.ts',
    'sol-live/goal-decomposition.ts',
  ];
  for (const file of required) await expectFile(file);

  for (const obsolete of ['vite.config.ts', '.github/workflows/build-deploy.yml', '.github/workflows/pages.yml']) {
    await expectAbsent(obsolete);
  }

  const sourceDir = join(root, 'sol-live');
  const sourceFiles = (await readdir(sourceDir)).filter((name) => name.endsWith('.ts'));
  if (sourceFiles.length < 3) failures.push('The Sol source directory unexpectedly contains fewer than three TypeScript modules.');

  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (packageJson.name !== 'sol-agent-overlay') failures.push('package.json must identify this repository as sol-agent-overlay.');
  if (packageJson.scripts?.test !== 'node scripts/verify-repository.mjs') failures.push('npm test must run the repository verification script.');
  if (packageJson.scripts?.['build:agent'] !== 'node scripts/stage-and-build.mjs') failures.push('build:agent must invoke the deterministic staging script.');
  if (packageJson.scripts?.['typecheck:agent'] !== 'node scripts/stage-and-build.mjs --typecheck') failures.push('typecheck:agent must invoke the focused staged-agent type-check.');

  const workflow = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');
  if (!workflow.includes('npm ci')) failures.push('CI must use npm ci for a reproducible root-tooling installation.');
  if (!workflow.includes('npm test') && !workflow.includes('npm run test')) failures.push('CI must run repository verification.');
  if (!workflow.includes('npm run typecheck:agent')) failures.push('CI must type-check the staged agent.');
  if (!workflow.includes('npm run build:agent')) failures.push('CI must compile the staged agent.');

  const liveWorkflow = await readFile(join(root, '.github/workflows/rs-sol-live.yml'), 'utf8');
  if (!liveWorkflow.includes('cp ../../../sol-live/*.ts ./')) failures.push('The live runner must stage all Sol TypeScript modules.');
  if (liveWorkflow.includes('SOL_PASS: ') && !liveWorkflow.includes('SOL_PASS: ${{ secrets.SOL_PASS }}')) failures.push('The live runner must not contain a hard-coded password value.');

  const workflowDir = join(root, '.github/workflows');
  for (const name of await readdir(workflowDir)) {
    if (!name.endsWith('.yml')) continue;
    const contents = await readFile(join(workflowDir, name), 'utf8');
    if (contents.includes('git push')) failures.push(`Workflow must not self-modify repository code: .github/workflows/${name}`);
  }

  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  if (lock.lockfileVersion < 3) failures.push('package-lock.json must use a current npm lockfile format.');

  const scriptPath = join(root, 'scripts/stage-and-build.mjs');
  const scriptInfo = await stat(scriptPath);
  if (!scriptInfo.isFile()) failures.push('The staging build script is invalid.');
  const stagingScript = await readFile(scriptPath, 'utf8');
  if (!stagingScript.includes("git', ['fetch', '--depth', '1', 'origin', upstreamRef]")) failures.push('The staging build script must fetch the pinned upstream revision explicitly.');

  if (failures.length) {
    console.error('Repository verification failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Repository verification passed. ${sourceFiles.length} Sol TypeScript modules are staged by the canonical build path.`);
}

main().catch((error) => {
  console.error(`Repository verification crashed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
