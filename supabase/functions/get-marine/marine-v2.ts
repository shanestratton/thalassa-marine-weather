import { readResponseJsonObjectLimited } from '../_shared/http-security.ts';
import { marineEnvelopeV2, marineQueryV2, type MarineKindV2, type MarinePointV2 } from '../_shared/marine-v2.ts';

const BASE = 'https://customer-marine-api.open-meteo.com/v1/marine';
export const MARINE_V2_SOURCE_BYTES = 750_000;
export const MARINE_V2_SOURCE_DEADLINE_MS = 3500;

/** The deadline covers headers AND bounded body consumption. No provider credentials leave this function. */
async function source(kind: MarineKindV2, point: MarinePointV2, key: string): Promise<unknown> {
    const abort = new AbortController(),
        timer = setTimeout(() => abort.abort(), MARINE_V2_SOURCE_DEADLINE_MS);
    try {
        const params = marineQueryV2(kind, point);
        params.set('apikey', key);
        const response = await fetch(`${BASE}?${params}`, { signal: abort.signal, redirect: 'error' });
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return null;
        }
        return await readResponseJsonObjectLimited(response, MARINE_V2_SOURCE_BYTES);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Two parallel public-weather reads, one quota-controlled caller. Each source keeps its own cell. */
export async function fetchMarineEnvelopeV2(point: MarinePointV2, key: string) {
    const [waves, motion] = await Promise.all([source('waves', point, key), source('motion', point, key)]);
    const result = marineEnvelopeV2(point, Date.now(), waves, motion);
    return result.waves || result.motion ? result : null;
}
