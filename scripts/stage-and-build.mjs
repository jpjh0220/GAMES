#!/usr/bin/env node

import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, 'sol-live');
const upstreamUrl = 'https://github.com/MaxBittker/rs-sdk.git';
const upstreamRef = process.env.RS_SDK_REF || '2ae032c99813a72d8d749d6d105fc7378255b03a';
const outputFile = resolve(process.env.SOL_BUILD_OUTPUT || join(root, 'dist', 'sol-live-agent.js'));
const skipInstall = process.argv.includes('--skip-install');
const keepWorkspace = process.argv.includes('--keep-workspace');
const typecheck = process.argv.includes('--typecheck');

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', rejectRun);
    child.on('exit', (code, signal) => {
      if (code === 0) return resolveRun();
      rejectRun(new Error(`${command} ${args.join(' ')} failed with ${signal || `exit code ${code}`}`));
    });
  });
}

async function assertDirectory(path, description) {
  try {
    if (!(await stat(path)).isDirectory()) throw new Error();
  } catch {
    throw new Error(`${description} is missing or is not a directory: ${path}`);
  }
}

async function prepareUpstream() {
  if (process.env.RS_SDK_DIR) {
    const path = resolve(process.env.RS_SDK_DIR);
    await assertDirectory(path, 'RS_SDK_DIR');
    return { path, temporary: false };
  }

  const path = await mkdtemp(join(tmpdir(), 'sol-rs-sdk-'));
  await run('git', ['clone', '--filter=blob:none', '--no-checkout', upstreamUrl, path]);
  await run('git', ['fetch', '--depth', '1', 'origin', upstreamRef], { cwd: path });
  await run('git', ['checkout', '--detach', upstreamRef], { cwd: path });
  return { path, temporary: true };
}

async function stageSolModules(targetDir) {
  await assertDirectory(sourceDir, 'Sol source directory');
  const required = ['sol-live.ts', 'agent-brain.ts', 'viewer.html'];
  for (const name of required) {
    if (!existsSync(join(sourceDir, name))) throw new Error(`Required Sol source file is missing: ${name}`);
  }

  const files = (await readdir(sourceDir)).filter((name) => name.endsWith('.ts') || name === 'viewer.html');
  for (const name of files) await cp(join(sourceDir, name), join(targetDir, name));
  console.log(`Staged ${files.length} Sol modules into ${targetDir}`);
}

async function main() {
  const workspace = await prepareUpstream();
  const webclientDir = join(workspace.path, 'server', 'webclient');
  try {
    await assertDirectory(webclientDir, 'Upstream rs-sdk webclient directory');
    if (!skipInstall) {
      await run('bun', ['install', '--frozen-lockfile'], { cwd: workspace.path });
      await run('bun', ['install', '--frozen-lockfile'], { cwd: webclientDir });
    }

    await stageSolModules(webclientDir);
    if (typecheck) {
      const configPath = join(webclientDir, '.sol-typecheck.json');
      const config = {
        extends: './tsconfig.json',
        files: ['sol-live.ts'],
      };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      try {
        await run('bun', ['x', 'tsc', '--noEmit', '--project', configPath], { cwd: webclientDir });
      } finally {
        await rm(configPath, { force: true });
      }
    }

    await mkdir(dirname(outputFile), { recursive: true });
    await run('bun', ['build', 'sol-live.ts', '--target=bun', `--outfile=${outputFile}`], { cwd: webclientDir });

    const result = await stat(outputFile);
    if (!result.isFile() || result.size === 0) throw new Error(`Build output was not created: ${outputFile}`);
    console.log(`Sol agent compiled successfully: ${outputFile} (${result.size} bytes)`);
  } finally {
    if (workspace.temporary && !keepWorkspace) await rm(workspace.path, { recursive: true, force: true });
    if (workspace.temporary && keepWorkspace) console.log(`Retained temporary SDK checkout: ${workspace.path}`);
  }
}

main().catch((error) => {
  console.error(`Sol build failed: ${error.message}`);
  process.exitCode = 1;
});
