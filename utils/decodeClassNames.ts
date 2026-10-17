/** Embedded production strings only; no remote input or application imports. */
import { unzlibSync } from 'fflate';
export function decodeClassNames(encoded: string, bytes: number, count: number, checksum: number): readonly string[] {
    if (
        encoded.length > 64_000 ||
        !Number.isSafeInteger(bytes) ||
        bytes < 1 ||
        bytes > 128_000 ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > 4096
    )
        throw Error('Invalid embedded class bounds');
    const input = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    if (
        input.length < 6 ||
        (input[0] & 15) !== 8 ||
        input[0] >>> 4 > 7 ||
        ((input[0] << 8) + input[1]) % 31 ||
        input[1] & 32
    )
        throw Error('Invalid embedded class header');
    const output = unzlibSync(input, { out: new Uint8Array(bytes) });
    let a = 1,
        b = 0;
    for (let start = 0; start < output.length; start += 5552) {
        for (let i = start; i < Math.min(start + 5552, output.length); i++) {
            a += output[i];
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    if (
        output.length !== bytes ||
        ((b << 16) | a) >>> 0 !== checksum ||
        new DataView(input.buffer, input.byteOffset + input.length - 4, 4).getUint32(0) !== checksum
    )
        throw Error('Embedded class checksum mismatch');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output));
    if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        !Array.isArray(value[0]) ||
        value[0].length > 8192 ||
        !value[0].every((word: unknown) => typeof word === 'string' && word.length <= 4096) ||
        !Array.isArray(value[1]) ||
        value[1].length !== count ||
        !value[1].every((row: unknown) => typeof row === 'string' && row.length <= 16_384 && /^[a-z0-9 ]*$/.test(row))
    )
        throw Error('Invalid embedded class table');
    const [words, rows] = value as [string[], string[]];
    let restored = 0;
    return Object.freeze(
        rows.map((row) =>
            row
                .split(' ')
                .map((key, indexInRow) => {
                    const index = parseInt(key, 36);
                    if (!/^[a-z0-9]+$/.test(key) || !Number.isSafeInteger(index) || index >= words.length)
                        throw Error('Invalid embedded class index');
                    restored += words[index].length + (indexInRow ? 1 : 0);
                    if (restored > 256_000) throw Error('Embedded class output exceeds reviewed bounds');
                    return words[index];
                })
                .join(' '),
        ),
    );
}
