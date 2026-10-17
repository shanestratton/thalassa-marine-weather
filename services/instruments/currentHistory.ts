import type { PiTrackHistoryPoint } from '../piTrackHistory';
import type { InstrumentEvidence, InstrumentReading } from './measurements';
import { measuredCurrent, type MeasuredCurrent } from './measuredCurrent';
export interface CurrentHistorySample {
    at: number;
    current: MeasuredCurrent;
}
/** Evaluate each historical vector at its recorded GPS time, preserving every sensor clock. */
export function currentHistory(points: readonly PiTrackHistoryPoint[]): {
    samples: CurrentHistorySample[];
    unqualified: number;
} {
    const samples: CurrentHistorySample[] = [];
    let unqualified = 0;
    for (const p of points) {
        const readings: InstrumentEvidence['readings'] = {};
        const add = (
            key: keyof InstrumentEvidence['readings'],
            value: number | null | undefined,
            at: number | null | undefined,
            unit: InstrumentReading['unit'],
            reference: InstrumentReading['reference'],
        ) => {
            if (typeof at === 'number')
                readings[key] = { value: value ?? null, at, unit, reference, source: 'Recorded Signal K leaf' };
        };
        add('sog', p.sog_kts, p.sog_at_ms, 'knots', 'ground');
        add('cogTrue', p.cog_deg, p.cog_true_at_ms, 'degrees', 'true');
        add('stw', p.stw_kts, p.stw_at_ms, 'knots', 'water');
        add('headingTrue', p.heading_true_deg, p.heading_true_at_ms, 'degrees', 'true');
        if (p.leeway_source) {
            add('leeway', p.leeway_deg, p.leeway_at_ms, 'degrees', 'relative');
            if (readings.leeway) readings.leeway.source = p.leeway_source;
        }
        const result = measuredCurrent({ identity: 'private-track-window', via: 'lan', readings }, p.at_ms);
        if (result.kind === 'available') samples.push({ at: p.at_ms, current: result });
        else unqualified++;
    }
    return { samples, unqualified };
}
