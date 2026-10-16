import type { PolarData } from '../types';
import { getPairing, pinnedPiRequest } from './PiPairingService';
import { isPinnedTransportAvailable } from './piTls';
import { piCache } from './PiCacheService';
import { loadLargeData, saveLargeData } from './nativeStorage';
import { polarPeriodAt, validPolarTable, type PolarPeriod } from '../pi-cache/src/polarLearningRule';
import { NmeaStore } from './NmeaStore';

interface PiPolarSnapshot {
    version: 1;
    enabled: boolean;
    updatedAt: number;
    polars: Record<PolarPeriod, PolarData | null>;
}
interface Cached {
    key: string;
    snapshot: PiPolarSnapshot;
}
const STORAGE = 'thalassa_pi_polar_snapshot_v1';
let cache: Cached | null = null;
let loaded = false;
let attempted = 0;
let pending: Promise<void> | null = null;
let configWork = Promise.resolve(false);
export type PiPolarSyncState = 'idle' | 'saving' | 'saved' | 'failed';
let syncState: PiPolarSyncState = 'idle';
const syncListeners = new Set<() => void>();
export const getPiPolarSyncState = (): PiPolarSyncState => syncState;
export function subscribePiPolarSync(listener: () => void): () => void {
    syncListeners.add(listener);
    return () => {
        syncListeners.delete(listener);
    };
}
function noteSync(state: PiPolarSyncState): void {
    syncState = state;
    for (const listener of syncListeners) listener();
}
const pairKey = () => {
    const p = getPairing();
    return p ? `${p.deviceId}:${p.publicKeySpki}` : null;
};
const cells = (polar: PolarData | null) => polar?.matrix.flat().filter((v) => v > 0).length ?? 0;
function validSnapshot(value: unknown): value is PiPolarSnapshot {
    if (!value || typeof value !== 'object') return false;
    const v = value as PiPolarSnapshot;
    return (
        v.version === 1 &&
        typeof v.enabled === 'boolean' &&
        Number.isFinite(v.updatedAt) &&
        v.updatedAt >= 0 &&
        !!v.polars &&
        ['all', 'day', 'night'].every((p) => {
            const polar = v.polars[p as PolarPeriod];
            return (
                polar === null ||
                (validPolarTable(polar) &&
                    JSON.stringify(polar.windSpeeds) === '[6,8,10,12,15,20,25]' &&
                    JSON.stringify(polar.angles) === '[45,60,90,120,150,180]')
            );
        })
    );
}
async function request(path: string, method: 'GET' | 'POST', data?: unknown): Promise<PiPolarSnapshot | null> {
    const key = pairKey();
    if (!key || !isPinnedTransportAvailable()) return null;
    try {
        const response = await pinnedPiRequest({
            url: `${piCache.baseUrl}/api/polars/${path}`,
            method,
            data,
            connectTimeout: 3000,
            readTimeout: 4000,
            responseType: 'text',
            ...(data ? { headers: { 'content-type': 'application/json' } } : {}),
        });
        if (
            pairKey() !== key ||
            response.status !== 200 ||
            typeof response.data !== 'string' ||
            response.data.length > 32768
        )
            return null;
        const value: unknown = JSON.parse(response.data);
        if (!validSnapshot(value)) return null;
        cache = { key, snapshot: value };
        await saveLargeData(STORAGE, cache);
        return value;
    } catch {
        return null;
    }
}

/** Serialized preference writes cannot let an earlier enable land after a later disable. */
export function configurePiPolarLearning(enabled: boolean): Promise<boolean> {
    configWork = configWork
        .catch(() => false)
        .then(async () => {
            if (!pairKey() || !isPinnedTransportAvailable()) return false;
            noteSync('saving');
            const { resolveRoutingPolar } = await import('./routingPolar');
            const { useSettingsStore } = await import('../stores/settingsStore');
            const settings = useSettingsStore.getState().settings;
            const baseline = enabled
                ? (await resolveRoutingPolar({ settings: { ...settings, polarSource: 'factory' } })).polar
                : undefined;
            const saved = (await request('config', 'POST', { enabled, ...(baseline ? { baseline } : {}) })) !== null;
            noteSync(saved ? 'saved' : 'failed');
            return saved;
        })
        .catch(() => {
            noteSync('failed');
            return false;
        });
    return configWork;
}

/** Paired Pi figures remain usable offline; a different pairing never inherits them. */
export async function getPiLearnedPolar(period?: PolarPeriod): Promise<PolarData | null> {
    const key = pairKey();
    if (!key) return null;
    if (!loaded) {
        loaded = true;
        try {
            const stored = (await loadLargeData(STORAGE)) as Cached | null;
            if (stored?.key === key && validSnapshot(stored.snapshot)) cache = stored;
        } catch {
            /* Phone cache is optional. */
        }
    }
    if (cache?.key !== key) {
        cache = null;
        attempted = 0;
    }
    if (isPinnedTransportAvailable() && (!attempted || Date.now() - attempted >= 60000)) {
        attempted = Date.now();
        pending ??= request('snapshot', 'GET')
            .then(() => undefined)
            .finally(() => {
                pending = null;
            });
        if (!cache) await pending;
    }
    if (pairKey() !== key || cache?.key !== key) return null;
    const navigation = NmeaStore.getState();
    const lat = navigation.latitude.value,
        lon = navigation.longitude.value;
    const age = Date.now() - Math.min(navigation.latitude.lastUpdated, navigation.longitude.lastUpdated);
    const phase =
        period ??
        (NmeaStore.isBoatFeed() && lat !== null && lon !== null && age >= -5000 && age <= 60000
            ? polarPeriodAt(Date.now(), lat, lon)
            : 'all');
    const preferred = cache.snapshot.polars[phase];
    return structuredClone(cells(preferred) >= 8 ? preferred : cache.snapshot.polars.all);
}
