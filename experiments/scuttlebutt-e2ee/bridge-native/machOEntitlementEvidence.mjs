/**
 * Pure, bounded Mach-O section evidence for a thin LE ARM64 executable.
 * This measures embedded bytes only: no signature, entitlement grant, simulator
 * admission, Keychain behavior, Auth or encryption claim is established here.
 * No filesystem, CLI, network or section contents enter the result/errors.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const HEADER_BYTES = 32;
const SEGMENT_BYTES = 72;
const SECTION_BYTES = 80;
const LC_SEGMENT_64 = 0x19;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const MAX_COMMAND_BYTES = 16 * 1024 * 1024;
const MAX_LOAD_COMMANDS = 4096;
const MAX_SECTIONS = 4096;
const MAX_ENTITLEMENT_BYTES = 1024 * 1024;
const MAX_U64 = (1n << 64n) - 1n;
const SECTION_NAMES = ['__entitlements', '__ents_der'];
const REFUSAL = 'Simulator Mach-O entitlement evidence refused';

function requireEvidence(condition) {
    if (!condition) throw new Error(REFUSAL);
}

// Mach-O names are fixed 16-byte fields. Refuse high-bit aliases and embedded
// data following a NUL instead of silently normalizing them into target names.
function nameAt(bytes, offset) {
    const field = bytes.subarray(offset, offset + 16);
    const nul = field.indexOf(0);
    const end = nul < 0 ? field.length : nul;
    requireEvidence(end > 0);
    for (let index = 0; index < end; index += 1) requireEvidence(field[index] >= 33 && field[index] <= 126);
    for (let index = end; index < field.length; index += 1) requireEvidence(field[index] === 0);
    return field.subarray(0, end).toString('ascii');
}

/**
 * @param {Buffer} bytes The complete executable bytes, without a fat wrapper.
 * @param {{__entitlements: string, __ents_der: string}} expected Exact lower-case
 * SHA-256 hashes of the linker input XML and DER files.
 * @returns {Readonly<{__entitlements: string, __ents_der: string}>} Measured hashes.
 */
function inspectSections(bytes, expected) {
    requireEvidence(Buffer.isBuffer(bytes) && bytes.length >= HEADER_BYTES && bytes.length <= MAX_BINARY_BYTES);
    requireEvidence(expected !== null && typeof expected === 'object');
    const expectedKeys = Reflect.ownKeys(expected);
    requireEvidence(expectedKeys.length === 2 && SECTION_NAMES.every((name) => expectedKeys.includes(name)));
    const expectedHashes = {};
    for (const name of SECTION_NAMES) {
        const descriptor = Object.getOwnPropertyDescriptor(expected, name);
        requireEvidence(descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string');
        requireEvidence(/^[0-9a-f]{64}$/.test(descriptor.value));
        expectedHashes[name] = descriptor.value;
    }
    requireEvidence(bytes.readUInt32LE(0) === 0xfeedfacf);
    requireEvidence(bytes.readUInt32LE(4) === 0x0100000c);
    requireEvidence(bytes.readUInt32LE(12) === 2);
    const commandCount = bytes.readUInt32LE(16);
    const commandBytes = bytes.readUInt32LE(20);
    requireEvidence(commandCount > 0 && commandCount <= MAX_LOAD_COMMANDS);
    requireEvidence(commandBytes > 0 && commandBytes <= MAX_COMMAND_BYTES && commandBytes % 8 === 0);
    requireEvidence(commandBytes <= bytes.length - HEADER_BYTES && commandCount <= commandBytes / 8);
    const commandEnd = HEADER_BYTES + commandBytes;
    const fileLength = BigInt(bytes.length);
    const sections = new Map();
    let cursor = HEADER_BYTES;
    let textSegments = 0;
    let totalSections = 0;
    for (let commandIndex = 0; commandIndex < commandCount; commandIndex += 1) {
        requireEvidence(cursor <= commandEnd - 8);
        const command = bytes.readUInt32LE(cursor);
        const commandSize = bytes.readUInt32LE(cursor + 4);
        requireEvidence(commandSize >= 8 && commandSize % 8 === 0 && commandSize <= commandEnd - cursor);
        if (command === LC_SEGMENT_64) {
            requireEvidence(commandSize >= SEGMENT_BYTES);
            const sectionCount = bytes.readUInt32LE(cursor + 64);
            totalSections += sectionCount;
            requireEvidence(totalSections <= MAX_SECTIONS);
            requireEvidence(commandSize === SEGMENT_BYTES + sectionCount * SECTION_BYTES);
            const segmentName = nameAt(bytes, cursor + 8);
            const virtualAddress = bytes.readBigUInt64LE(cursor + 24);
            const virtualSize = bytes.readBigUInt64LE(cursor + 32);
            const fileOffset = bytes.readBigUInt64LE(cursor + 40);
            const fileSize = bytes.readBigUInt64LE(cursor + 48);
            const segmentFlags = bytes.readUInt32LE(cursor + 68);
            requireEvidence(virtualSize <= MAX_U64 - virtualAddress);
            requireEvidence(fileOffset <= fileLength && fileSize <= fileLength - fileOffset);
            if (segmentName === '__TEXT') {
                textSegments += 1;
                requireEvidence(textSegments === 1);
                // SG_HIGHVM maps file bytes at the high end of a VM segment;
                // this evidence helper accepts the ordinary __TEXT mapping only.
                requireEvidence((segmentFlags & 0x1) === 0);
            }
            for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
                const offset = cursor + SEGMENT_BYTES + sectionIndex * SECTION_BYTES;
                const sectionName = nameAt(bytes, offset);
                requireEvidence(nameAt(bytes, offset + 16) === segmentName);
                const address = bytes.readBigUInt64LE(offset + 32);
                const size = bytes.readBigUInt64LE(offset + 40);
                const sectionOffset = BigInt(bytes.readUInt32LE(offset + 48));
                const alignment = bytes.readUInt32LE(offset + 52);
                const relocationOffset = BigInt(bytes.readUInt32LE(offset + 56));
                const relocationCount = BigInt(bytes.readUInt32LE(offset + 60));
                const sectionType = bytes.readUInt32LE(offset + 64) & 0xff;
                requireEvidence(address >= virtualAddress && address <= virtualAddress + virtualSize);
                requireEvidence(size <= virtualAddress + virtualSize - address);
                requireEvidence(alignment <= 31);
                if (relocationCount > 0n)
                    requireEvidence(
                        relocationOffset <= fileLength && relocationCount * 8n <= fileLength - relocationOffset,
                    );
                const zeroFill = sectionType === 0x1 || sectionType === 0xc || sectionType === 0x12;
                if (!zeroFill && size > 0n) {
                    requireEvidence(sectionOffset >= fileOffset && sectionOffset <= fileOffset + fileSize);
                    requireEvidence(size <= fileOffset + fileSize - sectionOffset);
                    requireEvidence(sectionOffset >= BigInt(commandEnd));
                    requireEvidence(sectionOffset % (1n << BigInt(alignment)) === 0n);
                }
                if (SECTION_NAMES.includes(sectionName)) {
                    requireEvidence(segmentName === '__TEXT' && sectionType === 0);
                    requireEvidence(size > 0n && size <= BigInt(MAX_ENTITLEMENT_BYTES));
                    requireEvidence(address - virtualAddress === sectionOffset - fileOffset);
                    requireEvidence(!sections.has(sectionName));
                    // The file/segment checks above bound conversion to Buffer's
                    // actual length; arbitrary u64 values never reach slicing.
                    sections.set(sectionName, { offset: Number(sectionOffset), size: Number(size) });
                }
            }
        }
        cursor += commandSize;
    }
    requireEvidence(cursor === commandEnd && textSegments === 1 && sections.size === 2);
    const xml = sections.get('__entitlements');
    const der = sections.get('__ents_der');
    requireEvidence(xml.offset + xml.size <= der.offset || der.offset + der.size <= xml.offset);
    const measured = {};
    for (const name of SECTION_NAMES) {
        const section = sections.get(name);
        const sectionBytes = bytes.subarray(section.offset, section.offset + section.size);
        const digest = createHash('sha256').update(sectionBytes).digest('hex');
        requireEvidence(digest === expectedHashes[name]);
        measured[name] = digest;
    }
    return Object.freeze(measured);
}

/**
 * @param {Buffer} bytes Complete thin LE ARM64 executable bytes.
 * @param {{__entitlements: string, __ents_der: string}} expected Linker input hashes.
 * @returns {Readonly<{__entitlements: string, __ents_der: string}>} Measured hashes only.
 */
export function inspectSimulatorEntitlementSections(bytes, expected) {
    try {
        return inspectSections(bytes, expected);
    } catch {
        // Do not propagate Buffer/parser errors or caller-supplied trap errors.
        throw new Error(REFUSAL);
    }
}
