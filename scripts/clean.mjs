import { rm } from 'node:fs/promises';

const paths = [
  'dist',
  'coverage',
  'apps/api/dist',
  'apps/web/dist',
  'apps/worker/dist',
  'packages/config/dist',
  'packages/contracts/dist',
  'packages/domain/dist',
  'packages/mcp/dist'
];

await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
