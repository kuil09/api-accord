import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const roots = [
  'apps/api/dist',
  'apps/web/dist',
  'apps/worker/dist',
  'packages/config/dist',
  'packages/domain/dist',
  'packages/mcp/dist'
];
const testFiles = [];
for (const root of roots) {
  testFiles.push(...await findTests(root));
}

if (testFiles.length === 0) {
  throw new Error('No compiled test files found. Run npm run build first.');
}

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) {
      resolve();
    } else {
      reject(new Error(`Tests failed with code ${code ?? 'null'} and signal ${signal ?? 'none'}`));
    }
  });
});

async function findTests(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findTests(path));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(path);
    }
  }
  return files;
}
