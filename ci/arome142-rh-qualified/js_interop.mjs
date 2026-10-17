// Pure-JS bootstrap: verify kernel/runtime/source before importing actual TS consumers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertJsAddressSpaceLimit } from './js_limits.mjs';
const [sourceArg, manifestArg, fixtureArg, gateArg] = process.argv.slice(2);
const source = path.resolve(sourceArg), fixture = path.resolve(fixtureArg), cohort = path.join(fixture, 'cohort');
assert.match(process.version, /^v24\./);
const hash = (raw) => createHash('sha256').update(raw).digest('hex');
const read = fs.readFile.bind(fs), write = fs.writeFile.bind(fs);
const gate = JSON.parse(await read(gateArg, 'utf8'));
assert.deepEqual(gate.rlimitAS, [17179869184, 17179869184]);
assert.equal(gate.internetAddressFamiliesDeniedBeforeEntry, true);
assert.ok(gate.inheritedFDsBeforeNodeExec.every(({ fd }) => [0, 1, 2].includes(fd)));
const ownCgroup = (await read('/proc/self/cgroup', 'utf8')).trim().split('\n').find((line) => line.startsWith('0::')).slice(3);
assert.equal(ownCgroup, gate.ownCgroup);
const ownLimits = {};
for (const key of ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max']) {
    ownLimits[key] = (await read(path.join('/sys/fs/cgroup', ownCgroup, key), 'utf8')).trim();
    assert.equal(ownLimits[key], gate.limits[key]);
}
const ownStatus = await read('/proc/self/status', 'utf8');
assert.match(ownStatus, /^NoNewPrivs:\s+1$/m);
for (const key of ['CapEff', 'CapPrm', 'CapInh', 'CapBnd', 'CapAmb']) assert.match(ownStatus, new RegExp(`^${key}:\\s+0+$`, 'm'));
const limitsText = await read('/proc/self/limits', 'utf8');
assertJsAddressSpaceLimit(limitsText);
const runtimeFds = [];
for (const fd of await fs.readdir('/proc/self/fd')) {
    let target;
    try { target = await fs.readlink(`/proc/self/fd/${fd}`); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assert.ok(runtimeFds.length < 64);
    if (Number(fd) > 2) assert.match(target, /^(anon_inode:|pipe:\[|\/dev\/null$)/);
    runtimeFds.push({ fd: Number(fd), target });
}
const manifest = JSON.parse(await read(manifestArg, 'utf8'));
const currentNode = await fs.open(process.execPath, 'r');
try {
    const digest = createHash('sha256');
    for await (const block of currentNode.createReadStream({ autoClose: false })) digest.update(block);
    assert.equal(digest.digest('hex'), manifest.nodeSha256);
} finally { await currentNode.close(); }
const actualFiles = {};
for (const [relative, expected] of Object.entries(manifest.files)) {
    assert.ok(!path.isAbsolute(relative) && !relative.includes('..'));
    const name = path.join(source, relative), s = await fs.lstat(name);
    assert.ok(s.isFile() && !s.isSymbolicLink() && s.uid === 0 && (s.mode & 0o222) === 0 && s.size <= 128 * 1024);
    const raw = await read(name); assert.equal(hash(raw), expected); actualFiles[relative] = expected;
}
assert.equal(Object.keys(actualFiles).length, 5);
const entry = path.join(source, 'tools/arome142/prove_rh_static_interop.mjs');
assert.ok(Object.hasOwn(actualFiles, 'tools/arome142/prove_rh_static_interop.mjs'));
const reads = [], writes = [];
fs.readFile = async (name, encoding) => {
    assert.equal(typeof name, 'string');
    const resolved = path.resolve(name), relative = path.relative(cohort, resolved);
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
    let cap;
    if (relative === 'prepared-slot.json') cap = 4096;
    else if (relative === 'manifest.json') cap = 262144;
    else if (relative === 'native-proof.json') cap = 1048576;
    else { assert.match(relative.replaceAll('\\', '/'), /^tiles\/[a-f0-9]{64}\.bin\.gz$/); cap = 3 * 1024**2; }
    const s = await fs.lstat(resolved);
    assert.ok(s.isFile() && !s.isSymbolicLink() && s.uid === 0 && (s.mode & 0o222) === 0 && s.size > 0 && s.size <= cap);
    const raw = await read(resolved); assert.equal(raw.length, s.size);
    assert.ok(reads.length < 16); reads.push({ path: relative, bytes: raw.length, sha256: hash(raw) });
    assert.ok(encoding === undefined || encoding === 'utf8'); return encoding ? raw.toString(encoding) : raw;
};
fs.writeFile = async (name, raw, options) => {
    assert.equal(path.resolve(name), path.join(fixture, 'rh-interop-proof.json'));
    assert.deepEqual(options, { flag: 'wx' }); assert.ok(Buffer.byteLength(raw) <= 65536 && writes.length === 0);
    writes.push(path.basename(name)); return write(name, raw, options);
};
globalThis.fetch = () => { throw new Error('implicit network fetch refused by generated-only interoperability'); };
await import(pathToFileURL(entry).href);
assert.equal(writes.length, 1);
const proof = { schema: 1, jsOnlyNoGribDecoder: true, node: process.version, nodeSha256: manifest.nodeSha256,
    trustedNodeBuiltinTsCompilerWasmAllowed: true, sourceFiles: actualFiles, reads, writes,
    actualKernelBeforeTsImport: { ownCgroup, limits: ownLimits, rlimitAS: gate.rlimitAS, noNewPrivileges: true, zeroCapabilities: true, runtimeFds },
    actualEntryPassed: true, providerRequests: 0, noFetchedOrUserWasm: true,
    ownMemoryPeakBytes: Number(await read(path.join('/sys/fs/cgroup', gate.ownCgroup, 'memory.peak'), 'utf8')) };
await write(path.join(fixture, 'js-boundary-proof.json'), JSON.stringify(proof), { flag: 'wx' });
console.log(JSON.stringify({ outcome: 'actual-ts-generated-interop-passed', sourceFiles: 5, reads: reads.length, providerRequests: 0 }));
