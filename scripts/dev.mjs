#!/usr/bin/env node
/**
 * Run the API and web dev servers together.
 *
 * `npm run dev:api & npm run dev:web` does not work on Windows: cmd.exe treats
 * `&` as "run sequentially", so the web server never starts until the API
 * exits. This spawns both as children and shuts them down together, which
 * behaves the same on Windows, macOS and Linux without adding a dependency.
 */
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const targets = [
  { name: 'api', args: ['run', 'dev', '--workspace=@pe/api'] },
  { name: 'web', args: ['run', 'dev', '--workspace=@pe/web'] },
];

const children = targets.map(({ name, args }) => {
  const child = spawn(npm, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => {
    // One server dying makes the other useless, so stop everything.
    if (code !== 0 && code !== null) {
      console.error(`\n[dev] ${name} exited with code ${code}`);
      shutdown(code);
    }
  });
  return child;
});

let stopping = false;

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
