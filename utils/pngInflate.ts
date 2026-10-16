/** fast-png's decode-only Pako seam, backed by the fflate codec jsPDF already
 * uses. This is not a general Pako replacement. PNG/APNG streams are complete
 * when fast-png reads result; IDAT fragments are retained until that boundary.
 * Header and Adler-32 checks retain zlib integrity checks fflate omits. */
import { unzlibSync } from 'fflate';

function adler32(bytes: Uint8Array): number {
    let a = 1,
        b = 0;
    for (let start = 0; start < bytes.length; start += 5552) {
        const end = Math.min(start + 5552, bytes.length);
        for (let i = start; i < end; i++) {
            a += bytes[i];
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
}
export class Inflate {
    err = 0;
    msg = '';
    private chunks: Uint8Array[] = [];
    private length = 0;
    private decoded: Uint8Array | undefined;
    push(chunk: Uint8Array): boolean {
        if (this.err) return false;
        if (!(chunk instanceof Uint8Array)) {
            this.err = -3;
            this.msg = 'Invalid PNG zlib input';
            return false;
        }
        this.chunks.push(chunk.slice());
        this.length += chunk.length;
        this.decoded = undefined;
        return true;
    }
    get result(): Uint8Array {
        if (this.decoded) return this.decoded;
        try {
            if (this.err || this.length < 6) throw new Error('Incomplete PNG zlib stream');
            const input = new Uint8Array(this.length);
            let offset = 0;
            for (const chunk of this.chunks) {
                input.set(chunk, offset);
                offset += chunk.length;
            }
            // PNG requires zlib's deflate method and no preset dictionary.
            if (
                (input[0] & 15) !== 8 ||
                input[0] >>> 4 > 7 ||
                ((input[0] << 8) + input[1]) % 31 !== 0 ||
                (input[1] & 32) !== 0
            )
                throw new Error('Invalid PNG zlib header');
            const output = unzlibSync(input);
            const checksum = new DataView(input.buffer, input.byteOffset + input.length - 4, 4).getUint32(0);
            if (adler32(output) !== checksum) throw new Error('Invalid PNG zlib checksum');
            this.decoded = output;
            this.chunks = [];
            return output;
        } catch (error) {
            this.err = -3;
            this.msg = error instanceof Error ? error.message : 'Invalid PNG zlib stream';
            throw new Error(this.msg);
        }
    }
}
export function inflate(input: Uint8Array): Uint8Array {
    const stream = new Inflate();
    stream.push(input);
    return stream.result;
}
