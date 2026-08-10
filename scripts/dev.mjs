#!/usr/bin/env node
/**
 * Dev launcher: runs the API server (tsx watch) and the Vite dev server side by
 * side with prefixed, colourised output. Zero dependencies on purpose — this is
 * a local developer tool and the launcher should stay trivially hackable.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const targets = [
  { name: 'api', color: '[38;5;44m', cwd: 'packages/server', args: ['run', 'dev'] },
  { name: 'web', color: '[38;5;177m', cwd: 'packages/web', args: ['run', 'dev'] },
];

const RESET = '[0m';
const DIM = '[2m';
const children = [];
let shuttingDown = false;

function prefixStream(stream, name, color) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      process.stdout.write(`${color}${name.padEnd(3)}${RESET} ${DIM}|${RESET} ${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buffer) process.stdout.write(`${color}${name.padEnd(3)}${RESET} ${DIM}|${RESET} ${buffer}\n`);
  });
}

for (const target of targets) {
  const child = spawn('npm', target.args, {
    cwd: new URL(`../${target.cwd}/`, import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  prefixStream(child.stdout, target.name, target.color);
  prefixStream(child.stderr, target.name, target.color);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    process.stdout.write(`${target.color}${target.name}${RESET} exited with code ${code}\n`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

process.stdout.write(
  `${DIM}Switchyard dev: API on http://127.0.0.1:7878, UI on http://127.0.0.1:5273${RESET}\n`,
);
