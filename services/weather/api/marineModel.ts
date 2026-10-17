/** Versioned Pi-first marine transport. Public forecasts only; no provider key or persistent position cache. */
import { piCache } from '../../PiCacheService';
import { getPairing, getPiEquipmentReadRevision, pinnedPiRequest } from '../../PiPairingService';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../../authIdentityScope';
import { getAuthenticatedFunctionHeaders } from '../../supabaseAuth';
import { useSettingsStore } from '../../../stores/settingsStore';
import { withTimeout } from '../../../utils/deadline';
import {
    marinePointV2,
    readMarineEnvelopeV2,
    type MarineEnvelopeV2,
    type MarinePointV2,
} from '../../../supabase/functions/_shared/marine-v2';
import { readResponseJsonObjectLimited } from '../../../supabase/functions/_shared/http-security';
import { mapMarineModelV2, type MarineModelReadingV2 } from '../marineModelV2';

export const MARINE_MODEL_HOP_MS = 4000;
export const MARINE_MODEL_MAX_BYTES = 1_600_000;
export const MARINE_MODEL_MAX_RAM_ENTRIES = 32;
const MAX_ACTIVE = 8;
type Stored = { envelope: MarineEnvelopeV2; via: 'pi' | 'supabase'; expiresAt: number };
const cache = new Map<string, Stored>();
const pending = new Map<string, Promise<MarineModelReadingV2 | null>>();
let generation = 0,
    context = '',
    active = 0;
/** Retirement drops private request context immediately; a retired promise cannot repopulate RAM. */
export function retireMarineModelV2(): void {
    generation++;
    context = '';
    cache.clear();
    pending.clear();
}
subscribeAuthIdentityScope(retireMarineModelV2);
useSettingsStore.subscribe((next, previous) => {
    if (next.activeVesselId !== previous.activeVesselId) retireMarineModelV2();
});
function currentContext(): string {
    const owner = getAuthIdentityScope(),
        pair = getPairing();
    return JSON.stringify([
        owner.key,
        owner.generation,
        useSettingsStore.getState().activeVesselId ?? null,
        piCache.baseUrl,
        getPiEquipmentReadRevision(),
        pair?.deviceId ?? null,
        pair?.publicKeySpki ?? null,
        pair?.pairedAt ?? null,
    ]);
}
function scope() {
    const next = currentContext();
    if (context !== next) {
        retireMarineModelV2();
        context = next;
    }
    return { context, generation };
}
function current(lease: ReturnType<typeof scope>): boolean {
    if (currentContext() !== context) {
        retireMarineModelV2();
        return false;
    }
    return lease.context === context && lease.generation === generation;
}
function boundedParse(text: string): unknown {
    if (text.length > MARINE_MODEL_MAX_BYTES || new TextEncoder().encode(text).byteLength > MARINE_MODEL_MAX_BYTES)
        return null;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}
async function pi(point: MarinePointV2, isCurrent: () => boolean): Promise<MarineEnvelopeV2 | null> {
    if (!piCache.canReachPinned()) return null;
    let alive = true;
    const admitted = () => alive && isCurrent();
    try {
        const params = new URLSearchParams({
            lat: point.latitude.toFixed(4),
            lon: point.longitude.toFixed(4),
            schema: '2',
        });
        const response = await withTimeout(
            pinnedPiRequest({
                url: `${piCache.baseUrl}/api/weather/marine?${params}`,
                connectTimeout: MARINE_MODEL_HOP_MS,
                readTimeout: MARINE_MODEL_HOP_MS,
                isCurrent: admitted,
            }).catch(() => null),
            null,
            MARINE_MODEL_HOP_MS,
        );
        if (
            !admitted() ||
            !response ||
            response.status < 200 ||
            response.status >= 300 ||
            typeof response.data !== 'string'
        )
            return null;
        return readMarineEnvelopeV2(boundedParse(response.data), point, Date.now());
    } catch {
        return null;
    } finally {
        alive = false;
    }
}
async function edge(point: MarinePointV2, isCurrent: () => boolean): Promise<MarineEnvelopeV2 | null> {
    const base = import.meta.env.VITE_SUPABASE_URL;
    if (!base) return null;
    const abort = new AbortController();
    let alive = true;
    try {
        return await withTimeout(
            (async () => {
                let headers: Record<string, string>;
                try {
                    headers = await getAuthenticatedFunctionHeaders();
                } catch {
                    const key = import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_KEY;
                    headers = key ? { Authorization: `Bearer ${key}`, apikey: key } : {};
                }
                if (!alive || !isCurrent()) return null;
                const params = new URLSearchParams({
                    lat: point.latitude.toFixed(4),
                    lon: point.longitude.toFixed(4),
                    schema: '2',
                });
                const response = await fetch(`${base}/functions/v1/get-marine?${params}`, {
                    headers,
                    signal: abort.signal,
                    redirect: 'error',
                });
                if (!response.ok || !alive || !isCurrent()) return null;
                const raw = await readResponseJsonObjectLimited(response, MARINE_MODEL_MAX_BYTES);
                return alive && isCurrent() ? readMarineEnvelopeV2(raw, point, Date.now()) : null;
            })().catch(() => null),
            null,
            MARINE_MODEL_HOP_MS,
        );
    } finally {
        alive = false;
        abort.abort();
    }
}
export async function fetchMarineModelV2(latitude: number, longitude: number): Promise<MarineModelReadingV2 | null> {
    if (!marinePointV2({ latitude, longitude })) return null;
    const point = { latitude: Number(latitude.toFixed(4)), longitude: Number(longitude.toFixed(4)) };
    const lease = scope(),
        key = `${point.latitude.toFixed(4)}:${point.longitude.toFixed(4)}`,
        now = Date.now();
    const existing = cache.get(key);
    if (existing && existing.expiresAt > now && current(lease))
        return mapMarineModelV2(existing.envelope, point, now, existing.via);
    cache.delete(key);
    const joined = pending.get(key);
    if (joined) return joined;
    if (active >= MAX_ACTIVE) return null;
    active++;
    const request = (async () => {
        let envelope = await pi(point, () => current(lease)),
            via: 'pi' | 'supabase' = 'pi';
        if (!current(lease)) return null;
        if (!envelope || (!envelope.waves && !envelope.motion)) {
            envelope = await edge(point, () => current(lease));
            via = 'supabase';
        }
        if (!current(lease) || !envelope) return null;
        const reading = mapMarineModelV2(envelope, point, Date.now(), via);
        if (!reading) return null;
        cache.set(key, { envelope, via, expiresAt: Math.min(Date.now() + 300000, envelope.fetched_at_ms + 3600000) });
        while (cache.size > MARINE_MODEL_MAX_RAM_ENTRIES) cache.delete(cache.keys().next().value!);
        return reading;
    })().finally(() => {
        active--;
        if (pending.get(key) === request) pending.delete(key);
    });
    pending.set(key, request);
    return request;
}
