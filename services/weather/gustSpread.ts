import type { AtmosVar, SpreadBlock } from './ModelSpreadService';
/** Same day/window as the existing wind agreement. Display-only members cannot enter a derivative. */
export function gustSpread(block: SpreadBlock<AtmosVar>, start: number, end: number): readonly [number, number] | null {
    const indices = block.times.flatMap((at, i) => (at >= start && at < end ? [i] : []));
    if (!indices.length) return null;
    const peaks = block.models
        .filter((m) => !m.displayOnly && !m.id.startsWith('ukmo'))
        .flatMap((model) => {
            const values = indices.map((i) => model.values.wind_gusts_10m?.[i]);
            return values.every((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 325)
                ? [Math.max(...values)]
                : [];
        });
    return peaks.length >= 2 ? [Math.min(...peaks), Math.max(...peaks)] : null;
}
