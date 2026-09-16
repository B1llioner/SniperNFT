import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import solc from 'solc';

const compiler = '0.8.26+commit.8a97fa7a.Emscripten.clang';
if (solc.version() !== compiler) throw new Error(`Genesis child compiler must be ${compiler}.`);
const file = 'contracts/GenesisChildFactory.sol';
const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const settings = {
  optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'shanghai',
  outputSelection: { '*': { '': ['ast'], '*': ['abi', 'storageLayout', 'evm.bytecode.object',
    'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
};
const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [file]: { content: source } }, settings })));
for (const error of output.errors ?? []) console.error(error.formattedMessage);
if ((output.errors ?? []).length) throw new Error('Genesis child compilation must finish without warnings or errors.');
const contracts = {};
for (const name of ['GenesisChildFactory', 'GenesisMintChild']) {
  const contract = output.contracts[file][name];
  const ast = output.sources[file].ast.nodes.find(node => node.nodeType === 'ContractDefinition' && node.name === name);
  const immutableIds = Object.fromEntries(ast.nodes.filter(node => node.nodeType === 'VariableDeclaration'
    && node.stateVariable && node.mutability === 'immutable').map(node => [node.name, String(node.id)]));
  contracts[name] = {
    contractName: name, source: file, sourceSha256, abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`, deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
    immutableReferences: contract.evm.deployedBytecode.immutableReferences, immutableIds, storageLayout: contract.storageLayout,
  };
  console.log(`${name}: init ${contract.evm.bytecode.object.length / 2} bytes, runtime ${contract.evm.deployedBytecode.object.length / 2} bytes`);
}
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('../artifacts/GenesisChildFactory.json', import.meta.url), `${JSON.stringify({
  schemaVersion: 1, compiler, settings, sourceSha256: { [file]: sourceSha256 }, contracts,
}, null, 2)}\n`);
