import { copyFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

if (!(await exists('.env'))) {
  await copyFile('.env.example', '.env');
  process.stdout.write('Created .env from .env.example.\n');
}

await run('docker', ['compose', '-f', 'infra/docker-compose.yml', 'up', '-d', '--wait', 'postgres']);
await run('npm', ['run', 'db:migrate']);
process.stdout.write('Bootstrap complete. Run `npm run dev`.\n');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with code ${code ?? 'null'} and signal ${signal ?? 'none'}`));
      }
    });
  });
}
