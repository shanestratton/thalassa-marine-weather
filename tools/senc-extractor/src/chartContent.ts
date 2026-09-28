import { isDeepStrictEqual } from 'node:util';

/**
 * Same chart revision can be rebuilt into a newer o-charts package. The
 * SENC build date is not the ENC issue/update date and changes no chart data.
 * Ignore only that direct cell field, retaining every navigation field and
 * every unknown field. Array order stays significant; object-key order does not.
 */
export function sameChartContentIgnoringSencBuildDate(a: string | Buffer, b: string | Buffer): boolean {
    const boundedJson = (value: unknown, depth = 0): boolean => {
        if (depth > 128) return false;
        if (typeof value === 'number') return Number.isFinite(value);
        if (value === null || typeof value !== 'object') return true;
        return Object.values(value).every((child) => boundedJson(child, depth + 1));
    };
    const comparable = (raw: string | Buffer): Record<string, unknown> | null => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw.toString());
        } catch {
            return null;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !boundedJson(parsed)) return null;
        const batch = parsed as Record<string, unknown>;
        if (!Array.isArray(batch.cells) || batch.cells.length !== 1) return null;
        const cell = batch.cells[0];
        if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return null;
        const { sencCreateDate, ...content } = cell as Record<string, unknown>;
        if (sencCreateDate !== undefined && (typeof sencCreateDate !== 'string' || !/^\d{8}$/.test(sencCreateDate)))
            return null;
        return { ...batch, cells: [content] };
    };
    const left = comparable(a);
    const right = comparable(b);
    return left !== null && right !== null && isDeepStrictEqual(left, right);
}
