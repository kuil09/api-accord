import { spawn } from 'node:child_process';

await runOnce('tsc', ['-b']);

const children = [
  spawn('tsc', ['-b', '--watch', '--preserveWatchOutput'], { stdio: 'inherit' }),
  spawn(process.execPath, ['--watch', 'apps/api/dist/index.js'], { stdio: 'inherit' }),
  spawn(process.execPath, ['--watch', 'apps/web/dist/index.js'], { stdio: 'inherit' }),
  spawn(process.execPath, ['--watch', 'apps/worker/dist/index.js'], { stdio: 'inherit' })
];

let stopping = false;

function stop(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    child.kill(signal);
  }
}

for (const child of children) {
  child.once('error', (error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
    stop('SIGTERM');
  });
  child.once('exit', (code, signal) => {
    if (!stopping && code !== 0) {
      process.stderr.write(`Development process exited with code ${code ?? 'null'} and signal ${signal ?? 'none'}.\n`);
      process.exitCode = code ?? 1;
      stop('SIGTERM');
    }
  });
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

function runOnce(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} failed with code ${code ?? 'null'} and signal ${signal ?? 'none'}`));
      }
    });
  });
}
