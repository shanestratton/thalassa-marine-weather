import {
    parseWeatherPositionProof,
    parseWeatherPositionRequest,
    type WeatherPositionRequest,
} from '../../../utils/weatherPosition.ts';
import type { PiRelayIdentity } from '../_shared/pi-relay-auth.ts';
export interface PositionRpc {
    rpc(
        name: string,
        body: Record<string, unknown>,
    ): PromiseLike<{ data: unknown; error: unknown }> & {
        abortSignal?: (signal: AbortSignal) => PromiseLike<{ data: unknown; error: unknown }>;
    };
}
/** Runs only after existing relay auth + bounded legacy parse/store. A missing
 * held migration cannot break ordinary instruments or imply readiness. */
export async function recordWeatherPosition(
    admin: PositionRpc,
    identity: PiRelayIdentity,
    body: Record<string, unknown>,
    zoneAt: (lat: number, lon: number) => string,
    now = Date.now(),
): Promise<WeatherPositionRequest | null> {
    try {
        const proof = body.source === 'pi' ? parseWeatherPositionProof(body.weather_position_v1, now) : null;
        const query = admin.rpc('weather_position_telemetry', {
            p_owner_id: identity.ownerId,
            p_relay_id: identity.relayId,
            p_proof: proof,
            p_zone: proof ? zoneAt(proof.lat, proof.lon) : null,
        });
        const timed = query.abortSignal ? query.abortSignal(AbortSignal.timeout(1500)) : query;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
            timed,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Optional proof timeout')), 1500);
            }),
        ]).finally(() => {
            if (timer) clearTimeout(timer);
        });
        return !result.error ? parseWeatherPositionRequest(result.data, now) : null;
    } catch {
        return null;
    }
}
