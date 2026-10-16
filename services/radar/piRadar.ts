/** Private RAM-only cache read. No fallback, raw frames or target positions leave the paired boat LAN. */
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { getPairing, pinnedPiRequest } from '../PiPairingService';
import { piCache } from '../PiCacheService';
import { isPinnedTransportAvailable } from '../piTls';
import { utf8ByteLength } from '../enc/types';
import { decodePiRadarPicture, RADAR_PI_BYTES, type PiRadarPicture } from './radarWire';
export interface OwnedPiRadarPicture extends PiRadarPicture {
    /** Rechecked by the RAM store on every read, including before identity notifications arrive. */
    isCurrent: () => boolean;
}
export class PiRadarError extends Error {
    constructor(readonly code: 'unavailable' | 'update' | 'invalid' | 'cancelled') {
        super(
            code === 'update'
                ? 'Update the Pi to receive radar targets.'
                : code === 'cancelled'
                  ? 'Radar read cancelled.'
                  : code === 'invalid'
                    ? 'The Pi radar cache could not be verified.'
                    : 'The paired radar feed is unavailable.',
        );
    }
}
export async function loadPiRadarPicture(
    options: { signal?: AbortSignal; isCurrent?: () => boolean } = {},
): Promise<OwnedPiRadarPicture> {
    const scope = getAuthIdentityScope(),
        record = getPairing(),
        pairing = record ? { ...record } : null,
        base = piCache.lanBaseUrlNow();
    if (!base || !pairing?.publicKeySpki || !isPinnedTransportAvailable()) throw new PiRadarError('unavailable');
    const identityCurrent = () => {
        const next = getPairing();
        return (
            isAuthIdentityScopeCurrent(scope) &&
            piCache.lanBaseUrlNow() === base &&
            next?.deviceId === pairing.deviceId &&
            next?.publicKeySpki === pairing.publicKeySpki &&
            next?.pairedAt === pairing.pairedAt
        );
    };
    const guard = () => {
        if (!identityCurrent() || options.signal?.aborted || options.isCurrent?.() === false)
            throw new PiRadarError('cancelled');
    };
    guard();
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const started = performance.now();
    try {
        const response = await Promise.race([
            pinnedPiRequest({
                url: `${base}/api/radar/targets`,
                method: 'GET',
                responseType: 'text',
                connectTimeout: 2000,
                readTimeout: 4000,
            }),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new PiRadarError('unavailable')), 5000);
                abort = () => reject(new PiRadarError('cancelled'));
                options.signal?.addEventListener('abort', abort, { once: true });
            }),
        ]);
        guard();
        if (performance.now() - started >= 5000) throw new PiRadarError('unavailable');
        if (response.status === 404) throw new PiRadarError('update');
        if (response.status !== 200) throw new PiRadarError('unavailable');
        if (
            typeof response.data !== 'string' ||
            response.data.length > RADAR_PI_BYTES ||
            utf8ByteLength(response.data, RADAR_PI_BYTES) > RADAR_PI_BYTES
        )
            throw new PiRadarError('invalid');
        let body: unknown;
        try {
            body = JSON.parse(response.data);
        } catch {
            throw new PiRadarError('invalid');
        }
        const picture = decodePiRadarPicture(body, Date.now());
        if (!picture) throw new PiRadarError('invalid');
        guard();
        return { ...picture, isCurrent: identityCurrent };
    } catch (error) {
        guard();
        throw error instanceof PiRadarError ? error : new PiRadarError('unavailable');
    } finally {
        clearTimeout(timer);
        if (abort) options.signal?.removeEventListener('abort', abort);
    }
}
