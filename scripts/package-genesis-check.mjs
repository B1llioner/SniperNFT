#!/usr/bin/env node
// Build a source-only, allowlisted CloudShell kit. Never reads wallet configuration.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CRATES = ['rust-genesis-minter', 'rust-mint-benchmark'];
const FIXED = [
  ...CRATES.flatMap(crate => [`${crate}/Cargo.toml`, `${crate}/Cargo.lock`]),
  'artifacts/GenesisChildFactory.json', 'contracts/GenesisChildFactory.sol',
  'artifacts/timed-benchmark.json', 'contracts/TimedBenchmarkNFT.sol',
  'contracts/TimedBenchmarkBatchMinter.sol', 'docs/RUST_GENESIS_MINT.md', 'docs/GENESIS_CHECK_SERVER.md',
];
const sha = data => createHash('sha256').update(data).digest('hex');

export async function sourceFiles(root = ROOT, profile = 'check') {
  if (!['check', 'mint'].includes(profile)) throw new Error('Invalid package profile');
  const files = [...FIXED, ...(profile === 'mint' ? ['docs/GENESIS_MINT_SERVER.md'] : [])];
  for (const crate of CRATES) {
    const entries = await readdir(path.join(root, crate, 'src'), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-z_]+\.rs$/.test(entry.name)) throw new Error('Unexpected Rust source entry');
      files.push(`${crate}/src/${entry.name}`);
    }
  }
  for (const file of files) {
    const stat = await lstat(path.join(root, file));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid source file');
  }
  return files.sort();
}

async function archive(directory, output, files) {
  const result = spawnSync('tar', ['-czf', output, '-C', directory, ...files], {
    env: { PATH: process.env.PATH, LANG: 'C', COPYFILE_DISABLE: '1' },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Source archive creation failed');
  const data = await readFile(output);
  if (data.length > 8 * 1024 * 1024) throw new Error('Source kit exceeds 8 MiB');
  return { sha256: sha(data), bytes: data.length };
}

export async function packageKit(outputDirectory, root = ROOT, profile = 'check') {
  if (!['check', 'mint'].includes(profile)) throw new Error('Invalid package profile');
  const prefix = `genesis-${profile}`;
  const output = path.resolve(outputDirectory);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 }); // Refuse accidental overwrite/repackaging.
  const files = await sourceFiles(root, profile);
  const contents = await Promise.all(files.map(file => readFile(path.join(root, file))));
  if (contents.reduce((sum, body) => sum + body.length, 0) > 8 * 1024 * 1024) throw new Error('Sources exceed 8 MiB');
  const sourceManifest = { kind: 'vinos-genesis-source-v1', files: Object.fromEntries(files.map((file, i) => [file, sha(contents[i])])) };
  // Stage exact bytes so concurrently edited inputs cannot change after hashing.
  const stage = path.join(output, 'source');
  await mkdir(stage, { mode: 0o700 });
  for (let i = 0; i < files.length; i++) {
    const target = path.join(stage, files[i]);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, contents[i], { flag: 'wx', mode: 0o600 });
  }
  await writeFile(path.join(stage, 'source-manifest.json'), JSON.stringify(sourceManifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const sourceArchive = `${prefix}-source.tgz`;
  const source = await archive(stage, path.join(output, sourceArchive), [...files, 'source-manifest.json']);
  const installers = profile === 'mint' ? ['install-genesis-check.sh', 'install-genesis-mint.sh'] : ['install-genesis-check.sh'];
  for (const installer of installers) {
    const sourcePath = path.join(root, 'scripts', installer);
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error('Invalid installer file');
    await copyFile(sourcePath, path.join(output, installer));
  }
  const installerHashes = Object.fromEntries(await Promise.all(installers.map(async name => [name, sha(await readFile(path.join(output, name)))])));
  const installerSha256 = installerHashes[`install-${prefix}.sh`];
  const manifest = { kind: `vinos-${prefix}-kit-v1`, sourceArchive, ...source, installerSha256, installerHashes,
    buildCommand: `bash install-${prefix}.sh build ${sourceArchive} ${source.sha256}`,
    target: 'x86_64-unknown-linux-gnu', instanceId: 'i-0ef42c1e5475d7edb', region: 'us-east-2',
    installRunsTransactions: false, launcher: `vinos-${prefix}` };
  await writeFile(path.join(output, 'kit-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const kit = await archive(output, path.join(output, `vinos-${prefix}-kit.tgz`), [sourceArchive, ...installers, 'kit-manifest.json']);
  console.log(JSON.stringify({ directory: output, source, kit, command: manifest.buildCommand }));
  return manifest;
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/package-genesis-check.mjs --output-dir NEW_DIRECTORY\nSource-only kit; build Linux binary in AWS CloudShell after source review.'); return;
  }
  if (args.length !== 2 || args[0] !== '--output-dir' || !args[1]) throw new Error('Use --output-dir NEW_DIRECTORY');
  await packageKit(args[1]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
