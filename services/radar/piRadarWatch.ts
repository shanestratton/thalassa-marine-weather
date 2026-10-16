/** Enrolled pinned boat-LAN controls only; no URL, identity or command supplied by a caller. */
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { getChartDevice, getPairing, pinnedPiRequest } from '../PiPairingService';
import { piCache } from '../PiCacheService';
import { isPinnedTransportAvailable } from '../piTls';
import { utf8ByteLength } from '../enc/types';
import { radarContextKey } from '../../utils/radarWatchContract';
import { sanitiseCollisionPrefs, type CollisionPrefs } from '../../utils/collisionRule';
import { decodePiRadarWatch, radarOwnerKey, type PiRadarWatchView } from './piRadarWatchWire';

export class PiRadarWatchError extends Error {
    constructor(readonly code: 'unavailable' | 'update' | 'invalid' | 'cancelled' | 'conflict') {
        super(
            code === 'update'
                ? 'Update the Pi for a radar watch.'
                : code === 'conflict'
                  ? 'The radar watch changed. Review its current controller before continuing.'
                  : code === 'cancelled'
                    ? 'Radar action cancelled.'
                    : 'The owned Pi radar watch could not be verified.',
        );
    }
}
export interface PiRadarWatchProof {
    view: PiRadarWatchView;
    deviceId: string;
    isCurrent: () => boolean;
    source?: 'lan' | 'cloud';
    cloudRevision?: string;
    acknowledgedKeys?: readonly string[];
}
type Options = { signal?: AbortSignal; isCurrent?: () => boolean };
type Action =
    | { kind: 'read' }
    | { kind: 'arm'; proof: PiRadarWatchProof; prefs: CollisionPrefs; replace: boolean }
    | { kind: 'off'; proof: PiRadarWatchProof }
    | { kind: 'ack'; proof: PiRadarWatchProof; key: string }
    | { kind: 'review'; proof: PiRadarWatchProof };

async function request(action: Action, options: Options): Promise<PiRadarWatchProof> {
    const scope = getAuthIdentityScope(),
        record = getPairing(),
        pairing = record ? { ...record } : null,
        base = piCache.lanBaseUrlNow();
    if (!scope.userId || !base || !pairing?.publicKeySpki || !isPinnedTransportAvailable())
        throw new PiRadarWatchError('unavailable');
    if (action.kind !== 'read' && action.proof.source === 'cloud') throw new PiRadarWatchError('unavailable');
    const started = performance.now();
    let expired = false;
    const ownerCurrent = () => {
        const next = getPairing();
        return (
            isAuthIdentityScopeCurrent(scope) &&
            next?.deviceId === pairing.deviceId &&
            next?.publicKeySpki === pairing.publicKeySpki &&
            next?.pairedAt === pairing.pairedAt
        );
    };
    // Transport loss makes a pending request unusable, not a held encounter clear.
    const identityCurrent = () => ownerCurrent() && piCache.lanBaseUrlNow() === base;
    const current = () =>
        !expired &&
        performance.now() - started < 6000 &&
        identityCurrent() &&
        !options.signal?.aborted &&
        options.isCurrent?.() !== false &&
        (action.kind === 'read' || action.proof.isCurrent());
    const guard = () => {
        if (!current()) throw new PiRadarWatchError(expired ? 'unavailable' : 'cancelled');
    };
    guard();
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
        return await Promise.race([
            (async () => {
                const device = await getChartDevice();
                guard();
                if (!device || (action.kind !== 'read' && device.chartDeviceId !== action.proof.deviceId))
                    throw new PiRadarWatchError('unavailable');
                let path = '/api/radar/watch',
                    data: unknown;
                if (action.kind !== 'read') {
                    const proof = action.proof,
                        view = proof.view;
                    if (
                        Date.now() - view.servedAt > 5000 ||
                        view.servedAt > Date.now() + 1000 ||
                        view.owner.ownerId !== scope.userId ||
                        view.owner.piDeviceId !== pairing.deviceId
                    )
                        throw new PiRadarWatchError('conflict');
                    if (action.kind === 'arm' || action.kind === 'off')
                        data = {
                            armed: action.kind === 'arm',
                            expected: view.context,
                            expectedOwnerRevision: view.ownerRevision,
                            ...(action.kind === 'arm'
                                ? {
                                      prefs: sanitiseCollisionPrefs(action.prefs),
                                      ...(action.replace ? { replaceController: true } : {}),
                                  }
                                : {}),
                        };
                    else {
                        if (!view.context) throw new PiRadarWatchError('conflict');
                        if (action.kind === 'ack') {
                            if (!view.alarms.some((c) => c.key === action.key && !c.cleared))
                                throw new PiRadarWatchError('conflict');
                            path += '/ack';
                            data = { context: view.context, key: action.key };
                        } else {
                            if (view.push.state !== 'conflict' || !view.push.conflictRevision)
                                throw new PiRadarWatchError('conflict');
                            path += '/relay-review';
                            data = { context: view.context, expectedContextRevision: view.push.conflictRevision };
                        }
                    }
                }
                if (data !== undefined && utf8ByteLength(JSON.stringify(data), 8192) > 8192)
                    throw new PiRadarWatchError('invalid');
                guard();
                const response = await pinnedPiRequest({
                    url: base + path,
                    method: action.kind === 'read' ? 'GET' : 'POST',
                    data,
                    responseType: 'text',
                    connectTimeout: 2000,
                    readTimeout: 4000,
                    isCurrent: current,
                });
                guard();
                if (response.status === 404) throw new PiRadarWatchError('update');
                if (response.status === 409) throw new PiRadarWatchError('conflict');
                if (response.status !== 200) throw new PiRadarWatchError('unavailable');
                if (typeof response.data !== 'string' || utf8ByteLength(response.data, 65536) > 65536)
                    throw new PiRadarWatchError('invalid');
                let raw: unknown;
                try {
                    raw = JSON.parse(response.data);
                } catch {
                    throw new PiRadarWatchError('invalid');
                }
                const view = await decodePiRadarWatch(raw, Date.now());
                guard();
                if (
                    !view ||
                    view.owner.ownerId !== scope.userId ||
                    view.owner.piDeviceId !== pairing.deviceId ||
                    (action.kind !== 'read' &&
                        (radarOwnerKey(view.owner) !== radarOwnerKey(action.proof.view.owner) ||
                            view.ownerRevision !== action.proof.view.ownerRevision))
                )
                    throw new PiRadarWatchError('invalid');
                if (action.kind === 'off' && view.context !== null) throw new PiRadarWatchError('conflict');
                if (action.kind === 'arm' && (!view.context || view.context.binding.deviceId !== device.chartDeviceId))
                    throw new PiRadarWatchError('conflict');
                if (
                    action.kind === 'ack' &&
                    radarContextKey(view.context) !== radarContextKey(action.proof.view.context)
                )
                    throw new PiRadarWatchError('conflict');
                return {
                    view,
                    deviceId: device.chartDeviceId,
                    isCurrent: ownerCurrent,
                    source: 'lan' as const,
                    ...(action.kind === 'ack' ? { acknowledgedKeys: [action.key] } : {}),
                };
            })(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    expired = true;
                    reject(new PiRadarWatchError('unavailable'));
                }, 6000);
                abort = () => reject(new PiRadarWatchError('cancelled'));
                options.signal?.addEventListener('abort', abort, { once: true });
            }),
        ]);
    } catch (error) {
        if (!identityCurrent() || options.signal?.aborted || options.isCurrent?.() === false)
            throw new PiRadarWatchError('cancelled');
        throw error instanceof PiRadarWatchError ? error : new PiRadarWatchError('unavailable');
    } finally {
        expired = true;
        clearTimeout(timer);
        if (abort) options.signal?.removeEventListener('abort', abort);
    }
}
export const readPiRadarWatch = (options: Options = {}) => request({ kind: 'read' }, options);
export const armPiRadarWatch = (
    proof: PiRadarWatchProof,
    prefs: CollisionPrefs,
    replace = false,
    options: Options = {},
) => request({ kind: 'arm', proof, prefs, replace }, options);
export const stopPiRadarWatch = (proof: PiRadarWatchProof, options: Options = {}) =>
    request({ kind: 'off', proof }, options);
export const acknowledgePiRadarWatch = (proof: PiRadarWatchProof, key: string, options: Options = {}) =>
    request({ kind: 'ack', proof, key }, options);
export const reviewPiRadarRelay = (proof: PiRadarWatchProof, options: Options = {}) =>
    request({ kind: 'review', proof }, options);
