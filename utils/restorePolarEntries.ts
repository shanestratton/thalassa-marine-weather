/** Embedded public catalogue arguments only. The original polar factory is
 * called unchanged, in its original order, after the complete table validates. */
import { decodeClassNames } from './decodeClassNames';
type PolarArguments = [string, string, number, 'cruiser' | 'racer-cruiser' | 'racer' | 'multihull'];
function valid(value: unknown): value is PolarArguments {
    return (
        Array.isArray(value) &&
        value.length === 4 &&
        typeof value[0] === 'string' &&
        value[0].length > 0 &&
        value[0].length <= 160 &&
        typeof value[1] === 'string' &&
        value[1].length > 0 &&
        value[1].length <= 80 &&
        typeof value[2] === 'number' &&
        Number.isFinite(value[2]) &&
        value[2] >= 5 &&
        value[2] <= 300 &&
        ['cruiser', 'racer-cruiser', 'racer', 'multihull'].includes(value[3])
    );
}
export function restorePolarEntries<T>(
    encoded: string,
    bytes: number,
    count: number,
    checksum: number,
    factory: (...args: PolarArguments) => T,
): T[] {
    if (!Number.isSafeInteger(count) || count < 1 || count > 512) throw Error('Invalid embedded polar count');
    const rows = decodeClassNames(encoded, bytes, count, checksum).map((row) => {
        const value: unknown = JSON.parse(row);
        if (!valid(value)) throw Error('Invalid embedded polar arguments');
        return value;
    });
    return rows.map((args) => factory(...args));
}
