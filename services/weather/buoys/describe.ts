/**
 * The one line the map inspect popup shows about the nearest wave buoy
 * (build 123, W1-11), in the user's units:
 *
 *   Measured 1.4 m · 9 s from SE · NDBC 46026 · 23 NM · 40 min ago
 *   Measured 2.1 m · NDBC 62107 (UK Met Office) · 7 NM · 1 h 5 min ago
 *   No wave buoy reporting within 50 NM
 *   No wave buoy feed read here yet
 *   Couldn't reach NDBC buoys just now
 *   NDBC buoys load in the app, not on the web
 *
 * The owner is always credited: the station label carries it when the owner
 * runs the network ("NDBC 46026"), brackets add it otherwise. Readings that
 * were not measured are left out rather than shown as 0.
 *
 * Kept free of transport code so the popup chunk does not carry the feeds.
 */
import { degreesToCardinal } from '../../../utils/format';
import { mToFt } from '../../../utils/units';
import type { UnitPreferences } from '../../../types/units';
import type { BuoyObs, NearestBuoyResult } from './types';

export type BuoyLineUnits = Partial<Pick<UnitPreferences, 'waveHeight' | 'distance'>>;

function height(m: number, unit: BuoyLineUnits['waveHeight']): string {
    const value = unit === 'ft' ? mToFt(m) : m;
    const shown = value < 10 ? value.toFixed(1) : String(Math.round(value));
    return `${shown} ${unit === 'ft' ? 'ft' : 'm'}`;
}

function distance(nm: number, unit: BuoyLineUnits['distance']): string {
    const [value, suffix] = unit === 'km' ? [nm * 1.852, 'km'] : unit === 'mi' ? [nm * 1.15078, 'mi'] : [nm, 'NM'];
    return `${value < 1 ? '<1' : Math.round(value)} ${suffix}`;
}

function age(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min ago` : `${hours} h ago`;
}

function station(obs: BuoyObs): string {
    if (!obs.owner) return `${obs.label} (owner not listed)`;
    return obs.label.startsWith(obs.owner) ? obs.label : `${obs.label} (${obs.owner})`;
}

function sea(obs: BuoyObs): string | null {
    const period = obs.periodS !== null ? `${Math.round(obs.periodS)} s` : null;
    const from = obs.fromDeg !== null ? `from ${degreesToCardinal(obs.fromDeg)}` : null;
    return period && from ? `${period} ${from}` : (period ?? from);
}

const names = (list: string[]): string => list.join(' and ');

export function describeNearestBuoy(
    result: NearestBuoyResult,
    units: BuoyLineUnits = {},
    nowMs: number = Date.now(),
): string {
    if (result.status === 'found') {
        const { obs } = result;
        return [
            `Measured ${height(obs.hsM ?? 0, units.waveHeight)}`,
            sea(obs),
            station(obs),
            distance(result.distanceNm, units.distance),
            age(nowMs - obs.time),
        ]
            .filter(Boolean)
            .join(' · ');
    }
    const failed = result.unreachable.filter((u) => u.reason === 'failed').map((u) => u.name);
    if (failed.length) return `Couldn't reach ${names(failed)} buoys just now`;
    const webOnly = result.unreachable.filter((u) => u.reason === 'web').map((u) => u.name);
    if (webOnly.length) return `${names(webOnly)} buoys load in the app, not on the web`;
    // Outside every network the app reads, "no buoy" would often be false
    // (Sydney, Marseille, Tokyo Bay all have live buoys): say what is true.
    if (!result.covered) return 'No wave buoy feed read here yet';
    return `No wave buoy reporting within ${distance(result.radiusNm, units.distance)}`;
}
