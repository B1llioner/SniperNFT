import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import solc from 'solc';

const compiler = '0.8.26+commit.8a97fa7a.Emscripten.clang';
if (solc.version() !== compiler) throw new Error(`Timed benchmark compiler must be ${compiler}.`);
const files = ['contracts/TimedBenchmarkNFT.sol', 'contracts/TimedBenchmarkBatchMinter.sol'];
const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, {
  content: await readFile(new URL(`../${file}`, import.meta.url), 'utf8'),
}])));
const settings = {
  optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
  outputSelection: { '*': { '': ['ast'], '*': ['abi', 'storageLayout', 'evm.bytecode.object',
    'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
};
const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings })));
for (const error of output.errors ?? []) console.error(error.formattedMessage);
if ((output.errors ?? []).length) throw new Error('Timed benchmark compilation must finish without warnings or errors.');
const contracts = {};
for (const [file, name] of [[files[0], 'TimedBenchmarkNFT'], [files[1], 'TimedBenchmarkBatchMinter'], [files[1], 'TimedBenchmarkMintHelper']]) {
  const contract = output.contracts[file][name];
  const ast = output.sources[file].ast.nodes.find(node => node.nodeType === 'ContractDefinition' && node.name === name);
  const immutableIds = Object.fromEntries(ast.nodes.filter(node => node.nodeType === 'VariableDeclaration'
    && node.stateVariable && node.mutability === 'immutable').map(node => [node.name, String(node.id)]));
  contracts[name] = {
    contractName: name, source: file, sourceSha256: createHash('sha256').update(sources[file].content).digest('hex'),
    abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`,
    deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
    immutableReferences: contract.evm.deployedBytecode.immutableReferences, immutableIds,
    storageLayout: contract.storageLayout,
  };
  console.log(`${name}: init ${contract.evm.bytecode.object.length / 2} bytes, runtime ${contract.evm.deployedBytecode.object.length / 2} bytes`);
}
const artifact = { schemaVersion: 1, compiler, settings, contracts,
  statuses: { Minted: 0, Partial: 1, SoldOut: 2, NotArmed: 3, TooEarly: 4, Expired: 5, AlreadyAttempted: 6 },
  sourceSha256: Object.fromEntries(files.map(file => [file, createHash('sha256').update(sources[file].content).digest('hex')])),
};
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('../artifacts/timed-benchmark.json', import.meta.url), `${JSON.stringify(artifact, null, 2)}\n`);
