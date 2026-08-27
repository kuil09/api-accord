import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const ROOT = process.cwd();
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const TEXT_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.json', '.yml', '.yaml', '.sql', '.css', '.html', '.md']);
const errors = [];

for (const file of await collectFiles(ROOT)) {
  const path = relative(ROOT, file);
  const extension = extname(file);
  if (!TEXT_EXTENSIONS.has(extension) && !['AGENTS.md', 'README.md', 'CONTRIBUTING.md'].includes(path)) {
    continue;
  }

  const content = await readFile(file, 'utf8');
  if (content.includes('\r\n')) {
    errors.push(`${path}: CRLF line endings are not allowed`);
  }
  if (extension !== '.md') {
    content.split('\n').forEach((line, index) => {
      if (/\s+$/u.test(line)) {
        errors.push(`${path}:${index + 1}: trailing whitespace`);
      }
    });
  }
  if (extension === '.ts' && /console\.(log|debug|info|warn|error)\s*\(/u.test(content)) {
    errors.push(`${path}: use the structured Logger instead of console.*`);
  }
  if (extension === '.json') {
    try {
      JSON.parse(content);
    } catch (error) {
      errors.push(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Repository lint passed.\n');
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}
