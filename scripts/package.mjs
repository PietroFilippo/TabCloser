import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'artifacts'), { recursive: true });
await import('./build.mjs');
execFileSync(process.execPath, [
  path.join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js'),
  'build',
  '--source-dir', 'dist',
  '--artifacts-dir', 'artifacts',
  '--overwrite-dest',
], { cwd: root, stdio: 'inherit' });
