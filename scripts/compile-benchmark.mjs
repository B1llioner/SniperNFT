import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import solc from 'solc';

const compiler = '0.8.26+commit.8a97fa7a.Emscripten.clang';
if (solc.version() !== compiler) throw new Error(`Benchmark compiler must be ${compiler}.`);
const file = 'contracts/SequencerBenchmarkNFT.sol';
const name = 'SequencerBenchmarkNFT';
const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const settings = {
  optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
  outputSelection: { '*': {
    '': ['ast'],
    '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'],
  } },
};
const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [file]: { content: source } }, settings })));
for (const error of output.errors ?? []) console.error(error.formattedMessage);
if ((output.errors ?? []).some(error => error.severity === 'error')) process.exit(1);
const contract = output.contracts[file][name];
const ast = output.sources[file].ast.nodes.find(node => node.nodeType === 'ContractDefinition' && node.name === name);
// solc keys immutableReferences by the variable declaration's AST ID, not name
// or source order. Preserve that association explicitly for runtime verification.
const immutableIds = Object.fromEntries(ast.nodes.filter(node => node.nodeType === 'VariableDeclaration'
  && node.stateVariable && node.mutability === 'immutable').map(node => [node.name, String(node.id)]));
if (Object.keys(immutableIds).sort().join(',') !== 'owner,runId') throw new Error('Unexpected benchmark immutable declarations.');
const artifact = {
  contractName: name, source: file, sourceSha256: createHash('sha256').update(source).digest('hex'),
  compiler, settings, abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
  deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
  immutableReferences: contract.evm.deployedBytecode.immutableReferences, immutableIds,
};
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL(`../artifacts/${name}.json`, import.meta.url), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`${name}: init code ${contract.evm.bytecode.object.length / 2} bytes, runtime ${contract.evm.deployedBytecode.object.length / 2} bytes`);
