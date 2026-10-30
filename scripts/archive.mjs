import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const dir = path.resolve(process.env.EXPORT_DIR || '/workspace/exports');
await mkdir(dir, { recursive: true });
const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
  file = path.join(dir, 'double-y-source-' + sha + '.zip');
execFileSync('git', ['archive', '--format=zip', '--output=' + file, 'HEAD']);
console.log('Committed source archive:', file);
console.log('Only committed source included; no databases, secrets, or dependencies.');
