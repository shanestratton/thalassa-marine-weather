export class BinaryReader {
    private offset = 0;
    constructor(private readonly buf: Buffer) {}

    remaining(): number {
        return this.buf.length - this.offset;
    }

    position(): number {
        return this.offset;
    }

    seek(pos: number): void {
        if (pos < 0 || pos > this.buf.length) {
            throw new RangeError(`seek ${pos} out of bounds [0, ${this.buf.length}]`);
        }
        this.offset = pos;
    }

    skip(n: number): void {
        this.seek(this.offset + n);
    }

    readUInt8(): number {
        const v = this.buf.readUInt8(this.offset);
        this.offset += 1;
        return v;
    }

    readUInt16LE(): number {
        const v = this.buf.readUInt16LE(this.offset);
        this.offset += 2;
        return v;
    }

    readUInt32LE(): number {
        const v = this.buf.readUInt32LE(this.offset);
        this.offset += 4;
        return v;
    }

    readInt32LE(): number {
        const v = this.buf.readInt32LE(this.offset);
        this.offset += 4;
        return v;
    }

    readFloatLE(): number {
        const v = this.buf.readFloatLE(this.offset);
        this.offset += 4;
        return v;
    }

    readDoubleLE(): number {
        const v = this.buf.readDoubleLE(this.offset);
        this.offset += 8;
        return v;
    }

    readBytes(n: number): Buffer {
        const slice = this.buf.subarray(this.offset, this.offset + n);
        this.offset += n;
        return slice;
    }

    readCString(maxLen: number): string {
        const slice = this.buf.subarray(this.offset, this.offset + maxLen);
        const nul = slice.indexOf(0);
        const end = nul === -1 ? maxLen : nul;
        const s = slice.subarray(0, end).toString('utf8');
        this.offset += maxLen;
        return s;
    }
}

export interface RecordHeader {
    type: number;
    recordLength: number;
}

export const RECORD_HEADER_SIZE = 6;

export function readRecordHeader(reader: BinaryReader): RecordHeader {
    const type = reader.readUInt16LE();
    const recordLength = reader.readUInt32LE();
    return { type, recordLength };
}
