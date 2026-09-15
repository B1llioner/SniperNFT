import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import solc from 'solc';

const file = 'contracts/RareFriendsBatchMinter.sol';
const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const settings = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'shanghai',
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
};
const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [file]: { content: source } }, settings })));
for (const error of output.errors ?? []) console.error(error.formattedMessage);
if ((output.errors ?? []).some(error => error.severity === 'error')) process.exit(1);
const directory = new URL('../artifacts/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const name of ['RareFriendsBatchMinter', 'RareFriendsMintHelper']) {
  const contract = output.contracts[file][name];
  const artifact = {
    contractName: name, source: file, sourceSha256: createHash('sha256').update(source).digest('hex'),
    compiler: solc.version(), settings, abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
    deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
    immutableReferences: contract.evm.deployedBytecode.immutableReferences,
  };
  await writeFile(new URL(`${name}.json`, directory), `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`${name}: init code ${contract.evm.bytecode.object.length / 2} bytes`);
}
