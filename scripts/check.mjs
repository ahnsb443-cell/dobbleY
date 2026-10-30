import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = ['server.mjs'];
for (const dir of ['lib', 'public', 'scripts', 'test'])
  for (const f of await readdir(dir)) if (/\.(mjs|js)$/.test(f)) files.push(dir + '/' + f);
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (r.status) process.exit(r.status);
}
console.log('Syntax checked ' + files.length + ' source files.');
