import { subscribeAuthIdentityScope } from '../authIdentityScope';
import type { PressureSample } from '../../utils/barometerTendency';
import type { NmeaPressure } from './additionalSentences';

/** Session-only atmospheric pressure. No inferred altitude/sea-level correction. */
let rows: PressureSample[] = [];
let identity: string | null = null;
let label: string | null = null;
const listeners = new Set<() => void>();
const changed = () => {
    for (const listener of listeners) listener();
};
export function clearGatewayPressure(): void {
    rows = [];
    identity = null;
    label = null;
    changed();
}
subscribeAuthIdentityScope(clearGatewayPressure);

export function recordGatewayPressure(reading: NmeaPressure, at: number, feed: string): void {
    const now = Date.now();
    if (
        !Number.isFinite(at) ||
        at <= 0 ||
        at > now + 1000 ||
        now - at > 13_000 ||
        !Number.isFinite(reading.hpa) ||
        reading.hpa < 800 ||
        reading.hpa > 1100
    )
        return;
    const nextIdentity = `${feed}:${reading.source}`;
    if (identity !== nextIdentity) rows = [];
    identity = nextIdentity;
    label = reading.source;
    if (rows.length && at <= rows[rows.length - 1].t) return;
    // One sample per minute keeps six hours bounded even on a busy gateway.
    const last = rows.at(-1);
    if (last && Math.floor(at / 60_000) === Math.floor(last.t / 60_000))
        rows[rows.length - 1] = { t: at, hpa: reading.hpa };
    else rows.push({ t: at, hpa: reading.hpa });
    rows = rows.filter((row) => row.t >= now - 6 * 3600_000).slice(-361);
    changed();
}
export function gatewayPressure(now = Date.now()): { samples: PressureSample[]; label: string } | null {
    const latest = rows.at(-1);
    return latest && now >= latest.t - 1000 && now - latest.t <= 13_000 && label
        ? { samples: rows.map((row) => ({ ...row })), label }
        : null;
}
export function subscribeGatewayPressure(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
