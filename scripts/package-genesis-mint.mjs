#!/usr/bin/env node
// Public mint profile of the same reviewed source-only CloudShell packager.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageKit as sharedPackageKit, sourceFiles as sharedSourceFiles } from './package-genesis-check.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const sourceFiles = (root = ROOT) => sharedSourceFiles(root, 'mint');
export const packageKit = (outputDirectory, root = ROOT) => sharedPackageKit(outputDirectory, root, 'mint');

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/package-genesis-mint.mjs --output-dir NEW_DIRECTORY\nSource-only public mint kit; the existing checker stays installed.');
    return;
  }
  if (args.length !== 2 || args[0] !== '--output-dir' || !args[1]) throw new Error('Use --output-dir NEW_DIRECTORY');
  await packageKit(args[1]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
