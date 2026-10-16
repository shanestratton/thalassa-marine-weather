/** Read existing aboard fields only. Never fetches, renews a source clock,
 * grows the two-frame marine cache or mistakes ocean uo/vo for tidal streams. */
import { WindStore } from '../../stores/WindStore';
import { currentImportedGrib } from './localGribImport';
import { readCachedCmemsFrames, CMEMS_CACHE_TTL_MS } from './api/cmemsGridTrust';
import { holdingGridMaximum } from './holdingGridBounds';
import type { HoldingBounds } from '../enc/holdingFootprint';
export interface HoldingFieldRead {
    source: string;
    maximum: number | null;
    unit: 'kt' | 'm';
    originalIssueMs: number | null;
    verifiedAtMs: number | null;
    validFromMs: number | null;
    validUntilMs: number | null;
    completeAreaAndInterval: boolean;
}
export interface HoldingEnvironmentRead {
    wind: HoldingFieldRead;
    gust: HoldingFieldRead;
    waves: HoldingFieldRead;
    currents: HoldingFieldRead;
    completeLocalExposure: false;
    includesTidalStreams: false;
    notes: string[];
}
const missing = (source: string, unit: 'kt' | 'm'): HoldingFieldRead => ({
    source,
    unit,
    maximum: null,
    originalIssueMs: null,
    verifiedAtMs: null,
    validFromMs: null,
    validUntilMs: null,
    completeAreaAndInterval: false,
});
export function readHoldingEnvironment(
    bounds: HoldingBounds | null,
    fromMs: number,
    untilMs: number,
    nowMs: number,
    check: () => void,
): HoldingEnvironmentRead {
    check();
    const state = WindStore.getState(),
        imported = currentImportedGrib(),
        grid = state.grid;
    const notes: string[] = [],
        wind = missing('Aboard wind grid', 'kt'),
        gust = missing('Aboard gust grid', 'kt');
    if (grid && bounds) {
        const issue = imported?.wind === grid ? Date.parse(imported.refTime) : null;
        const offsets = grid.stepHours ?? grid.hourOffsets;
        const reference = Date.parse(grid.refTime ?? '');
        const metadata = {
            source:
                imported?.wind === grid
                    ? `Private GRIB centre ${imported.source.centre}, process ${imported.source.process}`
                    : `Aboard ${state.model} ${state.field} grid`,
            originalIssueMs: issue !== null && Number.isFinite(issue) ? issue : null,
            validFromMs: Number.isFinite(reference) && offsets?.length ? reference + offsets[0] * 3600000 : null,
            validUntilMs: Number.isFinite(reference) && offsets?.length ? reference + offsets.at(-1)! * 3600000 : null,
        };
        Object.assign(wind, metadata);
        Object.assign(gust, metadata);
        if (state.field === 'wind' || imported?.wind === grid) {
            const value = holdingGridMaximum(grid, bounds, fromMs, untilMs, 'vector', check);
            wind.maximum = value === null ? null : value * 1.943844492;
            wind.completeAreaAndInterval = value !== null;
        }
        const value = holdingGridMaximum(
            grid,
            bounds,
            fromMs,
            untilMs,
            state.field === 'gust' ? 'vector' : 'gust',
            check,
        );
        gust.maximum = value === null ? null : value * 1.943844492;
        gust.completeAreaAndInterval = value !== null;
        if (issue === null)
            notes.push(
                'Wind/gust original model issue is not established by this aboard adapter; grid valid time is not an issue clock.',
            );
        else if (issue > nowMs || nowMs - issue > 12 * 3600000)
            notes.push(
                'The original imported GRIB run is future-dated or older than the 12-hour holding review limit.',
            );
    } else notes.push('A complete spatial footprint and aboard wind/gust grid are absent.');
    const marine = (dataset: 'waves' | 'currents'): HoldingFieldRead => {
        const empty = missing(`CMEMS ${dataset} already retained aboard`, dataset === 'waves' ? 'm' : 'kt');
        if (!bounds) return empty;
        return (
            readCachedCmemsFrames(dataset, nowMs, (manifest, frames, checkedAtMs) => {
                const shape = frames[0].grid;
                const value = holdingGridMaximum(
                    shape,
                    bounds,
                    fromMs,
                    untilMs,
                    'vector',
                    check,
                    (step) => {
                        const g = frames.find((f) => f.step === step)?.grid;
                        return { u: g?.u[step], v: g?.v[step], mask: g?.landMask };
                    },
                    true,
                );
                notes.push(
                    `CMEMS ${dataset} publication ${manifest.published_at}; manifest verification expires ${new Date(checkedAtMs + CMEMS_CACHE_TTL_MS).toISOString()}. Neither clock establishes the original model issue.`,
                );
                return {
                    ...empty,
                    source: `${manifest.dataset.id} · ${manifest.generation}`,
                    maximum: value === null ? null : value * (dataset === 'currents' ? 1.943844492 : 1),
                    verifiedAtMs: checkedAtMs,
                    validFromMs: Date.parse(manifest.data_start),
                    validUntilMs: Date.parse(manifest.data_end),
                    completeAreaAndInterval: value !== null,
                };
            }) ?? empty
        );
    };
    const waves = marine('waves'),
        currents = marine('currents');
    for (const [label, field] of Object.entries({ wind, gust, waves, currents }))
        if (!field.completeAreaAndInterval)
            notes.push(
                `${label}: full envelope cells and every temporal bracket are absent, masked, malformed or outside the bounded aboard read.`,
            );
    notes.push(
        'CMEMS uo/vo represents ocean circulation; tidal streams and local harbour currents are not included. Missing current is unknown, never zero.',
    );
    notes.push(
        'Forecast grids do not prove local shelter, seabed holding, tide-driven flow or full exposure. No new network request was made.',
    );
    check();
    return { wind, gust, waves, currents, completeLocalExposure: false, includesTidalStreams: false, notes };
}
