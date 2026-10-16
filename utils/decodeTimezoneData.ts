/** Decode only the app's embedded, reviewed timezone table; no remote input. */
import { unzlibSync } from 'fflate';

export function decodeTimezoneData(
    encoded: string,
    bytes: number,
    gridLength: number,
    zoneCount: number,
    checksum: number,
): [string, string[]] {
    if (
        encoded.length > 44_000 ||
        !Number.isSafeInteger(bytes) ||
        bytes < 1 ||
        bytes > 80_000 ||
        gridLength !== 65_024 ||
        zoneCount !== 438
    )
        throw Error('Invalid embedded timezone bounds');
    const input = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    if (
        input.length < 6 ||
        (input[0] & 15) !== 8 ||
        input[0] >>> 4 > 7 ||
        ((input[0] << 8) + input[1]) % 31 ||
        input[1] & 32
    )
        throw Error('Invalid embedded timezone zlib header');
    const output = unzlibSync(input, { out: new Uint8Array(bytes) });
    if (output.length !== bytes) throw Error('Embedded timezone byte length mismatch');
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
        ((b << 16) | a) >>> 0 !== checksum ||
        new DataView(input.buffer, input.byteOffset + input.length - 4, 4).getUint32(0) !== checksum
    )
        throw Error('Embedded timezone checksum mismatch');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output));
    if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        typeof value[0] !== 'string' ||
        value[0].length !== gridLength ||
        !Array.isArray(value[1]) ||
        value[1].length !== zoneCount ||
        !value[1].every((zone) => typeof zone === 'string' && /^[A-Za-z0-9_+/-]{1,80}$/.test(zone))
    )
        throw Error('Invalid embedded timezone table');
    return value as [string, string[]];
}
