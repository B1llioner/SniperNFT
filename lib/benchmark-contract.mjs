import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Interface, ZeroAddress, getAddress, isHexString, zeroPadValue } from 'ethers';

const SOURCE = 'contracts/SequencerBenchmarkNFT.sol';
const COMPILER = '0.8.26+commit.8a97fa7a.Emscripten.clang';
const REQUIRED_ABI = new Interface([
  'constructor(bytes32)', 'function owner() view returns (address)',
  'function runId() view returns (bytes32)', 'function mint(uint256) returns (uint256)',
  'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function getApproved(uint256) view returns (address)',
  'function approve(address,uint256)', 'function setApprovalForAll(address,bool)',
  'function isApprovedForAll(address,address) view returns (bool)',
  'function transferFrom(address,address,uint256)',
  'function safeTransferFrom(address,address,uint256)',
  'function safeTransferFrom(address,address,uint256,bytes)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
]);

function check(condition, message) { if (!condition) throw new Error(message); }
async function readBounded(url, limit) {
  const file = await open(url, 'r');
  try {
    const stats = await file.stat();
    check(stats.isFile() && stats.size <= limit, 'Benchmark artifact/source exceeds the file limit.');
    const data = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    check(length <= limit, 'Benchmark artifact/source exceeds the file limit.');
    return data.subarray(0, length);
  } finally { await file.close(); }
}

function immutableGroups(artifact) {
  const ids = artifact?.immutableIds;
  const references = artifact?.immutableReferences;
  check(ids && Object.keys(ids).sort().join(',') === 'owner,runId', 'Benchmark artifact needs named owner/runId immutable IDs.');
  check(Object.values(ids).every(id => typeof id === 'string' && /^[1-9]\d*$/.test(id))
    && ids.owner !== ids.runId, 'Invalid benchmark immutable IDs.');
  check(references && Object.keys(references).sort().join(',') === Object.values(ids).sort().join(','), 'Unexpected benchmark immutable references.');
  check(typeof artifact.deployedBytecode === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(artifact.deployedBytecode)
    && (artifact.deployedBytecode.length - 2) / 2 <= 24_576, 'Invalid benchmark runtime bytecode.');
  const runtime = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
  const occupied = new Set();
  return Object.fromEntries(Object.entries(ids).map(([name, id]) => {
    const group = references[id];
    check(Array.isArray(group) && group.length > 0, 'Missing benchmark immutable offsets.');
    for (const item of group) {
      check(item && Number.isSafeInteger(item.start) && item.start >= 0 && item.length === 32
        && item.start + 32 <= runtime.length, 'Invalid benchmark immutable offset.');
      for (let index = item.start; index < item.start + 32; index++) {
        check(!occupied.has(index), 'Overlapping benchmark immutable offsets.');
        check(runtime[index] === 0, 'Benchmark runtime must contain unpatched immutable placeholders.');
        occupied.add(index);
      }
    }
    return [name, group];
  }));
}

export async function loadBenchmarkArtifact() {
  const bytes = await readBounded(new URL('../artifacts/SequencerBenchmarkNFT.json', import.meta.url), 256 * 1024);
  const artifact = JSON.parse(bytes.toString('utf8'));
  check(artifact?.contractName === 'SequencerBenchmarkNFT' && artifact.source === SOURCE
    && artifact.compiler === COMPILER && artifact.settings?.evmVersion === 'shanghai'
    && artifact.settings?.optimizer?.enabled === true && artifact.settings.optimizer.runs === 200,
  'Unexpected benchmark artifact/compiler settings.');
  const source = await readBounded(new URL(`../${SOURCE}`, import.meta.url), 64 * 1024);
  check(createHash('sha256').update(source).digest('hex') === artifact.sourceSha256,
    'Benchmark source differs from its artifact; run npm run compile:benchmark.');
  check(typeof artifact.bytecode === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(artifact.bytecode)
    && (artifact.bytecode.length - 2) / 2 <= 49_152, 'Invalid benchmark creation bytecode.');
  check(Array.isArray(artifact.abi), 'Benchmark ABI is missing.');
  const iface = new Interface(artifact.abi);
  check(iface.deploy.inputs.length === 1 && iface.deploy.inputs[0].type === 'bytes32'
    && !iface.deploy.payable, 'Unexpected benchmark constructor ABI.');
  for (const expected of REQUIRED_ABI.fragments.filter(fragment => fragment.type === 'function')) {
    const actual = iface.getFunction(expected.format('sighash'));
    check(actual && actual.outputs.map(item => item.type).join(',') === expected.outputs.map(item => item.type).join(',')
      && (expected.constant ? actual.constant : actual.stateMutability === 'nonpayable'),
    `Unexpected benchmark ABI for ${expected.name}.`);
  }
  const transfer = iface.getEvent('Transfer');
  check(transfer && transfer.topicHash === REQUIRED_ABI.getEvent('Transfer').topicHash
    && transfer.inputs.every(input => input.indexed) && !transfer.anonymous, 'Unexpected benchmark Transfer ABI.');
  immutableGroups(artifact);
  return artifact;
}

/** Exact runtime for this deployer and run ID; no mutable storage is patched. */
export function expectedBenchmarkRuntime(artifact, owner, runId) {
  const groups = immutableGroups(artifact);
  const address = getAddress(owner);
  check(address !== ZeroAddress, 'Benchmark owner cannot be zero.');
  check(isHexString(runId, 32), 'Benchmark run ID must contain exactly 32 bytes.');
  const runtime = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
  const values = { owner: zeroPadValue(address, 32), runId };
  for (const [name, group] of Object.entries(groups)) {
    const word = Buffer.from(values[name].slice(2), 'hex');
    for (const { start } of group) word.copy(runtime, start);
  }
  return `0x${runtime.toString('hex')}`;
}
