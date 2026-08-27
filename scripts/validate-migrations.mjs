import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIGRATION_PATTERN = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/u;

export async function validateMigrations(directory = resolve('migrations')) {
  const files = await readdir(directory);
  const pairs = new Map();

  for (const file of files) {
    const match = MIGRATION_PATTERN.exec(file);
    if (match === null) {
      if (file.endsWith('.sql')) {
        throw new Error(`Invalid migration filename: ${file}`);
      }
      continue;
    }

    const [, idText, name, direction] = match;
    const key = `${idText}_${name}`;
    const current = pairs.get(key) ?? { id: Number(idText), name };

    if (current[direction] !== undefined) {
      throw new Error(`Duplicate ${direction} migration for ${key}`);
    }
    current[direction] = file;
    pairs.set(key, current);
  }

  const migrations = [...pairs.values()].sort((left, right) => left.id - right.id);
  if (migrations.length === 0) {
    throw new Error('At least one migration is required');
  }

  for (const [index, migration] of migrations.entries()) {
    const expectedId = index + 1;
    if (migration.id !== expectedId) {
      throw new Error(`Migration ids must be contiguous: expected ${String(expectedId).padStart(4, '0')}`);
    }
    if (migration.up === undefined || migration.down === undefined) {
      throw new Error(`${String(migration.id).padStart(4, '0')}_${migration.name} requires both up and down files`);
    }
  }

  return migrations;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const migrations = await validateMigrations();
  process.stdout.write(`Validated ${migrations.length} migration pair(s).\n`);
}
