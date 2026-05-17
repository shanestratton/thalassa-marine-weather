import { readFile } from 'node:fs/promises';
import { BinaryReader, readRecordHeader, RECORD_HEADER_SIZE } from './binaryReader.js';
import { RecordType, recordTypeName } from './recordTypes.js';
import { classAcronym, classRecord, loadS57Classes, ROUTING_CLASSES } from './s57Classes.js';

interface ScanSummary {
    totalRecords: number;
    totalBytes: number;
    byType: Map<number, { count: number; totalBytes: number }>;
    byFeatureClass: Map<number, { count: number; primitives: Map<number, number> }>;
    firstRecords: Array<{ offset: number; type: number; typeName: string; length: number; preview?: string }>;
    unknownTypes: Set<number>;
}

const PRIMITIVE_LABEL: Record<number, string> = { 0: '?', 1: 'P', 2: 'L', 3: 'A', 4: 'M' };

const PREVIEW_FIRST_N = 25;

async function scan(filePath: string): Promise<ScanSummary> {
    loadS57Classes();
    const buf = await readFile(filePath);
    const reader = new BinaryReader(buf);

    const summary: ScanSummary = {
        totalRecords: 0,
        totalBytes: buf.length,
        byType: new Map(),
        byFeatureClass: new Map(),
        firstRecords: [],
        unknownTypes: new Set(),
    };

    while (reader.remaining() >= RECORD_HEADER_SIZE) {
        const offset = reader.position();
        const header = readRecordHeader(reader);

        if (header.recordLength === 0) break;
        if (header.recordLength < RECORD_HEADER_SIZE) {
            console.error(
                `WARN: bogus recordLength=${header.recordLength} (< ${RECORD_HEADER_SIZE}) at offset ${offset}, type=${header.type}. Aborting.`,
            );
            break;
        }

        const payloadLen = header.recordLength - RECORD_HEADER_SIZE;
        if (payloadLen > reader.remaining()) {
            console.error(
                `WARN: payloadLen=${payloadLen} exceeds remaining ${reader.remaining()} at offset ${offset}, type=${header.type}. Aborting.`,
            );
            break;
        }

        const peekLen = Math.min(payloadLen, 64);
        const peek = buf.subarray(reader.position(), reader.position() + peekLen);

        if (header.type === RecordType.FEATURE_ID_RECORD && payloadLen >= 5) {
            const classCode = peek.readUInt16LE(0);
            const primitive = peek.readUInt8(4);
            const slot = summary.byFeatureClass.get(classCode) ?? { count: 0, primitives: new Map() };
            slot.count += 1;
            slot.primitives.set(primitive, (slot.primitives.get(primitive) ?? 0) + 1);
            summary.byFeatureClass.set(classCode, slot);
        }

        let preview: string | undefined;
        if (summary.firstRecords.length < PREVIEW_FIRST_N) {
            preview = formatPreview(header.type, peek, payloadLen);
        }

        reader.skip(payloadLen);

        summary.totalRecords += 1;
        const slot = summary.byType.get(header.type) ?? { count: 0, totalBytes: 0 };
        slot.count += 1;
        slot.totalBytes += header.recordLength;
        summary.byType.set(header.type, slot);

        const known = recordTypeName(header.type);
        if (known.startsWith('UNKNOWN_')) summary.unknownTypes.add(header.type);

        if (summary.firstRecords.length < PREVIEW_FIRST_N) {
            summary.firstRecords.push({
                offset,
                type: header.type,
                typeName: known,
                length: header.recordLength,
                preview,
            });
        }
    }

    return summary;
}

function formatPreview(type: number, peek: Buffer, totalPayloadLen: number): string {
    switch (type) {
        case RecordType.HEADER_SENC_VERSION:
        case RecordType.HEADER_CELL_EDITION:
        case RecordType.HEADER_CELL_UPDATE:
            if (peek.length >= 2) return `uint16=${peek.readUInt16LE(0)}`;
            return `(too short)`;
        case RecordType.HEADER_CELL_NATIVESCALE:
            if (peek.length >= 4) return `uint32=${peek.readUInt32LE(0)}`;
            return `(too short)`;
        case RecordType.HEADER_CELL_NAME:
        case RecordType.HEADER_CELL_PUBLISHDATE:
        case RecordType.HEADER_CELL_UPDATEDATE:
        case RecordType.HEADER_CELL_SENCCREATEDATE:
        case RecordType.HEADER_CELL_SOUNDINGDATUM:
            return JSON.stringify(decodeNullTerminated(peek));
        case RecordType.FEATURE_ID_RECORD:
            // Likely: uint16 featureTypeCode + uint16 featurePrimitive + uint32 RCID  (need to verify)
            return decodeFeatureIdPreview(peek);
        default:
            return hex(peek, 32) + (totalPayloadLen > peek.length ? '...' : '');
    }
}

function decodeFeatureIdPreview(peek: Buffer): string {
    if (peek.length < 5) return hex(peek, peek.length);
    const classCode = peek.readUInt16LE(0);
    const rcid = peek.readUInt16LE(2);
    const primitive = peek.readUInt8(4);
    return `class=${classAcronym(classCode)}(${classCode}) RCID=${rcid} prim=${PRIMITIVE_LABEL[primitive] ?? primitive}`;
}

function decodeNullTerminated(buf: Buffer): string {
    const nul = buf.indexOf(0);
    const end = nul === -1 ? buf.length : nul;
    return buf.subarray(0, end).toString('utf8');
}

function hex(buf: Buffer, max: number): string {
    return buf.subarray(0, Math.min(max, buf.length)).toString('hex');
}

async function main() {
    const file = process.argv[2];
    if (!file) {
        console.error('usage: scan <senc-file>');
        process.exit(1);
    }

    const summary = await scan(file);

    console.log(`File: ${file}`);
    console.log(`Total bytes: ${summary.totalBytes}`);
    console.log(`Total records: ${summary.totalRecords}`);
    console.log();
    console.log('Records by type:');
    const rows = [...summary.byType.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [type, { count, totalBytes }] of rows) {
        console.log(
            `  ${String(type).padStart(4)} ${recordTypeName(type).padEnd(40)} count=${String(count).padStart(6)}  bytes=${String(totalBytes).padStart(10)}`,
        );
    }

    if (summary.unknownTypes.size > 0) {
        console.log();
        console.log(`Unknown types seen: ${[...summary.unknownTypes].sort((a, b) => a - b).join(', ')}`);
    }

    console.log();
    console.log(`S-57 feature classes in this chart:`);
    const featRows = [...summary.byFeatureClass.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [code, { count, primitives }] of featRows) {
        const klass = classRecord(code);
        const acronym = klass?.acronym ?? `?${code}`;
        const name = klass?.name ?? '(unknown)';
        const primStr = [...primitives.entries()].map(([p, c]) => `${PRIMITIVE_LABEL[p] ?? p}:${c}`).join(' ');
        const flag = ROUTING_CLASSES.has(acronym) ? '*' : ' ';
        console.log(
            `  ${flag} ${String(code).padStart(4)} ${acronym.padEnd(8)} count=${String(count).padStart(6)}  prim=${primStr.padEnd(20)}  ${name}`,
        );
    }
    console.log('(* = layers consumed by Thalassa inshore router)');

    console.log();
    console.log(`First ${summary.firstRecords.length} records:`);
    for (const r of summary.firstRecords) {
        const tn = r.typeName.padEnd(40);
        console.log(
            `  @${String(r.offset).padStart(8)}  type=${String(r.type).padStart(3)} ${tn} len=${String(r.length).padStart(8)}  ${r.preview ?? ''}`,
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
