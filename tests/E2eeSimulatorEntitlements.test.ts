// @vitest-environment node
/** Synthetic Mach-O buffers exercise the pure parser only. These tests do not
 * establish native execution, simulator admission or any entitlement grant.
 * No filesystem, compiler, CLI, network, signature or device operations occur.
 */
import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { inspectSimulatorEntitlementSections } from '../experiments/scuttlebutt-e2ee/bridge-native/machOEntitlementEvidence.mjs';

const HEADER = 32;
const SEGMENT = HEADER;
const SECTION_ONE = SEGMENT + 72;
const SECTION_TWO = SECTION_ONE + 80;
const COMMAND_BYTES = 72 + 2 * 80;
const DATA_OFFSET = HEADER + COMMAND_BYTES;
const BASE_ADDRESS = 0x100000000n;
const REFUSAL = 'Simulator Mach-O entitlement evidence refused';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function name(bytes: Buffer, at: number, value: string) {
    bytes.fill(0, at, at + 16);
    bytes.write(value, at, 16, 'ascii');
}
function fixture() {
    const xml = Buffer.from('<plist><dict/></plist>');
    const der = Buffer.from([0x30, 0x04, 0x31, 0x02, 0x30, 0x00]);
    const bytes = Buffer.alloc(DATA_OFFSET + xml.length + der.length);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4);
    bytes.writeUInt32LE(2, 12);
    bytes.writeUInt32LE(1, 16);
    bytes.writeUInt32LE(COMMAND_BYTES, 20);
    bytes.writeUInt32LE(0x19, SEGMENT);
    bytes.writeUInt32LE(COMMAND_BYTES, SEGMENT + 4);
    name(bytes, SEGMENT + 8, '__TEXT');
    bytes.writeBigUInt64LE(BASE_ADDRESS, SEGMENT + 24);
    bytes.writeBigUInt64LE(4096n, SEGMENT + 32);
    bytes.writeBigUInt64LE(BigInt(bytes.length), SEGMENT + 48);
    bytes.writeUInt32LE(2, SEGMENT + 64);
    for (const [at, sectionName, offset, size] of [
        [SECTION_ONE, '__entitlements', DATA_OFFSET, xml.length],
        [SECTION_TWO, '__ents_der', DATA_OFFSET + xml.length, der.length],
    ] as const) {
        name(bytes, at, sectionName);
        name(bytes, at + 16, '__TEXT');
        bytes.writeBigUInt64LE(BASE_ADDRESS + BigInt(offset), at + 32);
        bytes.writeBigUInt64LE(BigInt(size), at + 40);
        bytes.writeUInt32LE(offset, at + 48);
    }
    xml.copy(bytes, DATA_OFFSET);
    der.copy(bytes, DATA_OFFSET + xml.length);
    return { bytes, expected: { __entitlements: hash(xml), __ents_der: hash(der) } };
}

describe('simulator entitlement sections — synthetic parser evidence only', () => {
    it('hashes the exact two section ranges through EOF without mutating inputs or returning contents', () => {
        const f = fixture();
        const original = Buffer.from(f.bytes);
        const expected = { ...f.expected };
        const measured = inspectSimulatorEntitlementSections(f.bytes, f.expected);
        expect(measured).toEqual(expected);
        expect(Object.keys(measured).sort()).toEqual(['__entitlements', '__ents_der']);
        expect(Object.isFrozen(measured)).toBe(true);
        expect(f.bytes.equals(original)).toBe(true);
        expect(f.expected).toEqual(expected);
    });

    it('walks another bounded load command without treating it as a section', () => {
        const f = fixture();
        const bytes = Buffer.concat([f.bytes.subarray(0, DATA_OFFSET), Buffer.alloc(8), f.bytes.subarray(DATA_OFFSET)]);
        bytes.writeUInt32LE(2, 16);
        bytes.writeUInt32LE(COMMAND_BYTES + 8, 20);
        bytes.writeUInt32LE(0x1b, DATA_OFFSET);
        bytes.writeUInt32LE(8, DATA_OFFSET + 4);
        bytes.writeBigUInt64LE(BigInt(bytes.length), SEGMENT + 48);
        for (const at of [SECTION_ONE, SECTION_TWO]) {
            bytes.writeBigUInt64LE(bytes.readBigUInt64LE(at + 32) + 8n, at + 32);
            bytes.writeUInt32LE(bytes.readUInt32LE(at + 48) + 8, at + 48);
        }
        expect(inspectSimulatorEntitlementSections(bytes, f.expected)).toEqual(f.expected);
    });

    it.each([
        ['wrong magic', (bytes: Buffer) => bytes.writeUInt32BE(0xfeedfacf, 0)],
        ['wrong CPU', (bytes: Buffer) => bytes.writeUInt32LE(0x01000007, 4)],
        ['non-executable', (bytes: Buffer) => bytes.writeUInt32LE(6, 12)],
        ['too many commands', (bytes: Buffer) => bytes.writeUInt32LE(4097, 16)],
        ['empty commands', (bytes: Buffer) => bytes.writeUInt32LE(0, 16)],
        ['command table overruns file', (bytes: Buffer) => bytes.writeUInt32LE(0x1000, 20)],
        ['short command', (bytes: Buffer) => bytes.writeUInt32LE(4, SEGMENT + 4)],
        ['unaligned command', (bytes: Buffer) => bytes.writeUInt32LE(COMMAND_BYTES - 1, SEGMENT + 4)],
        ['command overruns table', (bytes: Buffer) => bytes.writeUInt32LE(COMMAND_BYTES + 8, SEGMENT + 4)],
        ['section count disagrees with command size', (bytes: Buffer) => bytes.writeUInt32LE(3, SEGMENT + 64)],
        ['unconsumed command table', (bytes: Buffer) => bytes.writeUInt32LE(COMMAND_BYTES + 8, 20)],
        [
            'segment range exceeds file',
            (bytes: Buffer) => bytes.writeBigUInt64LE(BigInt(bytes.length + 1), SEGMENT + 48),
        ],
        ['huge segment file offset', (bytes: Buffer) => bytes.writeBigUInt64LE(1n << 63n, SEGMENT + 40)],
        ['unsupported high VM mapping', (bytes: Buffer) => bytes.writeUInt32LE(1, SEGMENT + 68)],
        ['huge section size', (bytes: Buffer) => bytes.writeBigUInt64LE(1n << 63n, SECTION_ONE + 40)],
        ['section range exceeds file', (bytes: Buffer) => bytes.writeUInt32LE(bytes.length, SECTION_TWO + 48)],
        [
            'section exceeds virtual segment',
            (bytes: Buffer) => bytes.writeBigUInt64LE(BASE_ADDRESS + 4096n, SECTION_ONE + 32),
        ],
        [
            'section VM and file mapping disagree',
            (bytes: Buffer) => bytes.writeBigUInt64LE(BASE_ADDRESS + BigInt(DATA_OFFSET) + 1n, SECTION_ONE + 32),
        ],
        ['section aliases load commands', (bytes: Buffer) => bytes.writeUInt32LE(HEADER, SECTION_ONE + 48)],
        ['section misalignment', (bytes: Buffer) => bytes.writeUInt32LE(8, SECTION_ONE + 52)],
        ['oversized alignment exponent', (bytes: Buffer) => bytes.writeUInt32LE(32, SECTION_ONE + 52)],
        [
            'relocations outside file',
            (bytes: Buffer) => {
                bytes.writeUInt32LE(bytes.length, SECTION_ONE + 56);
                bytes.writeUInt32LE(1, SECTION_ONE + 60);
            },
        ],
        ['empty XML section', (bytes: Buffer) => bytes.writeBigUInt64LE(0n, SECTION_ONE + 40)],
        ['zero-fill target', (bytes: Buffer) => bytes.writeUInt32LE(1, SECTION_ONE + 64)],
        ['non-regular target', (bytes: Buffer) => bytes.writeUInt32LE(2, SECTION_ONE + 64)],
        ['missing target', (bytes: Buffer) => name(bytes, SECTION_ONE, '__missing')],
        ['duplicate target', (bytes: Buffer) => name(bytes, SECTION_TWO, '__entitlements')],
        ['section segment-name mismatch', (bytes: Buffer) => name(bytes, SECTION_ONE + 16, '__DATA')],
        ['noncanonical name padding', (bytes: Buffer) => bytes.writeUInt8(0x78, SECTION_TWO + 15)],
        ['high-bit name alias', (bytes: Buffer) => bytes.writeUInt8(0xdf, SECTION_ONE)],
        ['overlapping target ranges', (bytes: Buffer) => bytes.writeUInt32LE(DATA_OFFSET, SECTION_TWO + 48)],
        ['payload hash mismatch', (bytes: Buffer) => bytes.writeUInt8(0, DATA_OFFSET)],
    ] as const)('refuses %s with fixed diagnostics', (_label, mutate) => {
        const f = fixture();
        mutate(f.bytes);
        expect(() => inspectSimulatorEntitlementSections(f.bytes, f.expected)).toThrow(REFUSAL);
    });

    it('refuses target names housed in a different segment', () => {
        const f = fixture();
        for (const at of [SEGMENT + 8, SECTION_ONE + 16, SECTION_TWO + 16]) name(f.bytes, at, '__DATA');
        expect(() => inspectSimulatorEntitlementSections(f.bytes, f.expected)).toThrow(REFUSAL);
    });

    it.each([0, 4, 31, 32, SECTION_ONE + 79, DATA_OFFSET - 1, DATA_OFFSET + 1])(
        'refuses a buffer truncated to %i bytes',
        (length) => {
            const f = fixture();
            expect(() => inspectSimulatorEntitlementSections(f.bytes.subarray(0, length), f.expected)).toThrow(REFUSAL);
        },
    );

    it('refuses duplicate __TEXT segments even if both expected section names exist', () => {
        const f = fixture();
        const duplicate = Buffer.from(f.bytes.subarray(SEGMENT, SECTION_ONE));
        duplicate.writeUInt32LE(72, 4);
        duplicate.writeUInt32LE(0, 64);
        const bytes = Buffer.concat([f.bytes.subarray(0, DATA_OFFSET), duplicate, f.bytes.subarray(DATA_OFFSET)]);
        bytes.writeUInt32LE(2, 16);
        bytes.writeUInt32LE(COMMAND_BYTES + 72, 20);
        bytes.writeBigUInt64LE(BigInt(bytes.length), SEGMENT + 48);
        for (const at of [SECTION_ONE, SECTION_TWO]) {
            bytes.writeBigUInt64LE(bytes.readBigUInt64LE(at + 32) + 72n, at + 32);
            bytes.writeUInt32LE(bytes.readUInt32LE(at + 48) + 72, at + 48);
        }
        expect(() => inspectSimulatorEntitlementSections(bytes, f.expected)).toThrow(REFUSAL);
    });

    it.each([
        {},
        { __entitlements: 'a'.repeat(64) },
        { __entitlements: 'A'.repeat(64), __ents_der: 'b'.repeat(64) },
        { __entitlements: 'a'.repeat(63), __ents_der: 'b'.repeat(64) },
        { __entitlements: 'a'.repeat(64), __ents_der: 'b'.repeat(64), extra: true },
    ])('refuses malformed expected-hash contracts without accepting partial results: %j', (expected) => {
        const f = fixture();
        expect(() => inspectSimulatorEntitlementSections(f.bytes, expected as typeof f.expected)).toThrow(REFUSAL);
    });

    it('refuses accessor-based expected hashes without invoking the getter', () => {
        const f = fixture();
        const getter = vi.fn(() => f.expected.__entitlements);
        const expected = Object.defineProperty({ __ents_der: f.expected.__ents_der }, '__entitlements', {
            get: getter,
        });
        expect(() => inspectSimulatorEntitlementSections(f.bytes, expected as typeof f.expected)).toThrow(REFUSAL);
        expect(getter).not.toHaveBeenCalled();
    });

    it('requires both actual hashes to match', () => {
        const f = fixture();
        expect(() =>
            inspectSimulatorEntitlementSections(f.bytes, { ...f.expected, __ents_der: '0'.repeat(64) }),
        ).toThrow(REFUSAL);
        expect(() =>
            inspectSimulatorEntitlementSections(f.bytes, { ...f.expected, __entitlements: '0'.repeat(64) }),
        ).toThrow(REFUSAL);
    });

    it('does not expose caller-supplied proxy errors in diagnostics', () => {
        const f = fixture();
        const expected = new Proxy(f.expected, {
            ownKeys() {
                throw new Error('Synthetic private diagnostic must never escape');
            },
        });
        let failure: unknown;
        try {
            inspectSimulatorEntitlementSections(f.bytes, expected);
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(REFUSAL);
    });
});
