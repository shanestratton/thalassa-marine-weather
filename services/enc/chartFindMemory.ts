/** Capped display-search RAM. Tokens fence late parses across identity and
 * cell changes. No feature/geometry references, persistence, logs or I/O. */
import { subscribeAuthIdentityScope } from '../authIdentityScope';
import {
    buildChartObjectIndex,
    normaliseChartQuery,
    type ChartObjectIndex,
    type ChartObject,
} from './chartObjectIndex';
import {
    canonicalEncCellId,
    ENC_CELL_ID_PATTERN,
    encCellStorageIdentity,
    type ChartLicence,
    type EncConversionResult,
} from './types';

export const CHART_FIND_MAX_CELLS = 8;
export const CHART_FIND_MAX_BYTES = 1024 * 1024;
export const CHART_FIND_MAX_RESULTS = 20;
const MAX_TOKENS = 256;
export interface ChartFindToken {
    readonly cellId: string;
    readonly epoch: number;
}
interface Held {
    token: ChartFindToken;
    index: ChartObjectIndex;
    licence: ChartLicence;
    proof: object;
}
const tokens = new Map<string, ChartFindToken>();
const indexes = new Map<string, Held>();
const listeners = new Set<() => void>();
let epoch = 0,
    bytes = 0;
const key = (id: string) => encCellStorageIdentity(id);
const emit = () => {
    for (const fn of [...listeners]) {
        try {
            fn();
        } catch {
            /* isolate consumers */
        }
    }
};
export function subscribeChartFind(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
export function captureChartFindCell(id: string): ChartFindToken | null {
    const canonical = canonicalEncCellId(id);
    if (!ENC_CELL_ID_PATTERN.test(canonical)) return null;
    const identity = key(canonical);
    let token = tokens.get(identity);
    if (!token) {
        token = Object.freeze({ cellId: canonical, epoch });
        tokens.set(identity, token);
        while (tokens.size > MAX_TOKENS) {
            const oldest = tokens.keys().next().value!;
            tokens.delete(oldest);
            dropChartFindCell(oldest);
        }
    }
    return token;
}
export const chartFindTokenCurrent = (token: ChartFindToken | null): token is ChartFindToken =>
    !!token && token.epoch === epoch && tokens.get(key(token.cellId)) === token;
/** LRU eviction removes derived names along with the parsed cell. */
export function dropChartFindCell(id: string): void {
    const identity = key(id),
        held = indexes.get(identity);
    if (!held) return;
    bytes -= held.index.bytes;
    indexes.delete(identity);
    emit();
}
/** A cell was replaced/deleted. Existing results and pending parses retire. */
export function retireChartFindCell(id: string): void {
    tokens.delete(key(id));
    dropChartFindCell(id);
}
/** Identity/Pi/memory retirement is synchronous, before another account or Pi
 * can query. Even a late worker reply carrying old bytes cannot re-publish. */
export function retireChartFindMemory(): void {
    epoch++;
    tokens.clear();
    indexes.clear();
    bytes = 0;
    emit();
}
subscribeAuthIdentityScope(retireChartFindMemory);
/** Capture before an import's I/O; metadata mutations have a separate registry revision. */
export const chartFindGeneration = () => epoch;

export function indexChartFindCell(
    token: ChartFindToken | null,
    blob: EncConversionResult,
    licence: ChartLicence,
): boolean {
    if (!chartFindTokenCurrent(token) || key(blob.cellId) !== key(token.cellId)) return false;
    const index = buildChartObjectIndex(blob);
    if (!chartFindTokenCurrent(token)) return false;
    dropChartFindCell(token.cellId);
    indexes.set(key(token.cellId), { token, index, licence, proof: {} });
    bytes += index.bytes;
    while (indexes.size > CHART_FIND_MAX_CELLS || bytes > CHART_FIND_MAX_BYTES)
        dropChartFindCell(indexes.keys().next().value!);
    emit();
    return indexes.has(key(token.cellId));
}
export interface ChartFindResult extends Omit<ChartObject, 'search'> {
    readonly licence: ChartLicence;
}
// A stale UI result must not pin an evicted cell's entire index in memory.
const results = new WeakMap<ChartFindResult, { token: ChartFindToken; proof: object }>();
export function chartFindResultCurrent(result: ChartFindResult): boolean {
    const proof = results.get(result);
    return !!proof && indexes.get(key(result.cellId))?.proof === proof.proof && chartFindTokenCurrent(proof.token);
}
export function searchChartFindMemory(query: string, permitted: (id: string, licence: ChartLicence) => boolean) {
    const needle = normaliseChartQuery(query.slice(0, 80));
    const found: Array<{ held: Held; object: ChartObject; rank: number }> = [];
    let limited = false,
        cells = 0;
    for (const held of indexes.values()) {
        if (!chartFindTokenCurrent(held.token) || !permitted(held.token.cellId, held.licence)) continue;
        cells++;
        limited ||= held.index.limited;
        if (!needle) continue;
        for (const object of held.index.objects) {
            if (!object.search.includes(needle)) continue;
            const name = normaliseChartQuery(object.name);
            found.push({ held, object, rank: name === needle ? 0 : name.startsWith(needle) ? 1 : 2 });
        }
    }
    found.sort(
        (a, b) =>
            a.rank - b.rank || a.object.name.localeCompare(b.object.name) || a.object.key.localeCompare(b.object.key),
    );
    limited ||= found.length > CHART_FIND_MAX_RESULTS;
    const matches = found.slice(0, CHART_FIND_MAX_RESULTS).map(({ held, object }) => {
        const { search: _search, ...display } = object;
        const result = Object.freeze({ ...display, licence: held.licence });
        results.set(result, { token: held.token, proof: held.proof });
        return result;
    });
    return { matches, cells, limited };
}
export const chartFindMemoryStats = () => ({ cells: indexes.size, bytes, tokenCount: tokens.size });
