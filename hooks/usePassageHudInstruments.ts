/**
 * usePassageHudInstruments — the six numbers the passage pane shows, and
 * nothing else.
 *
 * The pane sits on the chart, and the chart is the heaviest page in the app.
 * `useNmeaStore()` re-renders its caller on every instrument sample (several a
 * second with a Pi aboard), so this hook subscribes to the store directly and
 * only sets state when one of ITS values or freshness tiers actually changed.
 *
 * Honesty rules carried over from the Instrument Panel:
 *   - a metric that has gone 'dead' reads as null, never as its last value;
 *   - 'stale' keeps the value and says so, so the pane can dim it;
 *   - which lane the numbers came through (Pi over the LAN, the cloud row, or
 *     the gateway socket) is reported, because a cloud reading never steers.
 */
import { useEffect, useState } from 'react';
import {
    NmeaStore,
    type DataFreshness,
    type NmeaStoreState,
    type RemoteVia,
    type TimestampedMetric,
} from '../services/NmeaStore';

export interface HudMetric {
    value: number | null;
    freshness: DataFreshness;
}

export interface PassageHudInstruments {
    sog: HudMetric;
    cog: HudMetric;
    aws: HudMetric;
    awa: HudMetric;
    tws: HudMetric;
    twd: HudMetric;
    /** 'lan' | 'cloud' when a Pi feeds the store, null for the gateway socket. */
    via: RemoteVia | null;
    connectionStatus: NmeaStoreState['connectionStatus'];
}

const METRIC_KEYS = ['sog', 'cog', 'aws', 'awa', 'tws', 'twd'] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

const resolve = (metric: TimestampedMetric): HudMetric => ({
    value: metric.freshness === 'dead' ? null : metric.value,
    freshness: metric.freshness,
});

/** Instrument noise below this is not a change worth a repaint. */
const round1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

export function pickPassageHudInstruments(state: NmeaStoreState): PassageHudInstruments {
    const out = {
        via: state.remote?.via ?? null,
        connectionStatus: state.connectionStatus,
    } as PassageHudInstruments;
    for (const key of METRIC_KEYS) {
        const m = resolve(state[key]);
        out[key] = { value: round1(m.value), freshness: m.freshness };
    }
    return out;
}

function same(a: PassageHudInstruments, b: PassageHudInstruments): boolean {
    if (a.via !== b.via || a.connectionStatus !== b.connectionStatus) return false;
    return METRIC_KEYS.every(
        (key: MetricKey) => a[key].value === b[key].value && a[key].freshness === b[key].freshness,
    );
}

export function usePassageHudInstruments(): PassageHudInstruments {
    const [value, setValue] = useState<PassageHudInstruments>(() => pickPassageHudInstruments(NmeaStore.getState()));
    useEffect(
        () =>
            NmeaStore.subscribe((state) => {
                const next = pickPassageHudInstruments(state);
                setValue((prev) => (same(prev, next) ? prev : next));
            }),
        [],
    );
    return value;
}
