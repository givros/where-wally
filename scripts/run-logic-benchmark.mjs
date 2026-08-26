import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rolldown } from 'rolldown';

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'foundwally-logic-'));
const outputFile = path.join(temporaryDirectory, 'benchmark-crowd.mjs');

try {
  const bundle = await rolldown({
    input: path.resolve('scripts/benchmark-crowd.ts'),
    platform: 'node',
    transform: {
      define: {
        'import.meta.env.BASE_URL': JSON.stringify('/'),
      },
    },
  });
  await bundle.write({ file: outputFile, format: 'esm' });
  await bundle.close();

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [outputFile], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  } else {
    const assetExitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve('scripts/verify-character-crowd-glb.mjs')], {
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    if (assetExitCode !== 0) process.exitCode = assetExitCode;
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
