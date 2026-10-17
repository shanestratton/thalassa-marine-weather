/** Explicit one-shot check of an existing paired/enrolled Pi cache. No discovery packets or scanner commands. */
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { getChartDevice, getPairing, getPiEquipmentReadRevision } from '../PiPairingService';
import { loadPiRadarPicture, PiRadarError } from './piRadar';
export interface RadarEquipmentRead {
    source: 'paired-pi-target-feed';
    /** Generic TTM/TLL observations do not identify a manufacturer or scanner model. */
    model: null;
    piName: string;
    configured: boolean;
    connected: boolean;
    overloaded: boolean;
    checkedAt: number;
    lastFrameAt: number | null;
    isCurrent: () => boolean;
}
export async function checkPairedRadarEquipment(options: {
    signal: AbortSignal;
    isCurrent: () => boolean;
}): Promise<RadarEquipmentRead> {
    const scope = getAuthIdentityScope(),
        record = getPairing(),
        pair = record ? { ...record } : null,
        revision = getPiEquipmentReadRevision(),
        controller = new AbortController();
    if (!scope.userId || !pair) throw new PiRadarError('unavailable');
    let expired = false;
    const current = () => {
        const next = getPairing();
        return (
            !controller.signal.aborted &&
            !options.signal.aborted &&
            options.isCurrent() &&
            isAuthIdentityScopeCurrent(scope) &&
            getPiEquipmentReadRevision() === revision &&
            next?.deviceId === pair.deviceId &&
            next?.publicKeySpki === pair.publicKeySpki &&
            next?.pairedAt === pair.pairedAt
        );
    };
    const guard = () => {
        if (!current()) throw new PiRadarError(expired ? 'unavailable' : 'cancelled');
    };
    const forward = () => controller.abort();
    options.signal.addEventListener('abort', forward, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
    try {
        guard();
        return await Promise.race([
            (async () => {
                const enrolled = await getChartDevice();
                guard();
                if (!enrolled) throw new PiRadarError('unavailable');
                const picture = await loadPiRadarPicture({ signal: controller.signal, isCurrent: current });
                guard();
                const after = await getChartDevice();
                guard();
                if (after?.chartDeviceId !== enrolled.chartDeviceId || !picture.isCurrent())
                    throw new PiRadarError('cancelled');
                return {
                    source: 'paired-pi-target-feed' as const,
                    model: null,
                    piName:
                        typeof pair.boatName === 'string'
                            ? pair.boatName.replace(/\p{Cc}/gu, '').slice(0, 80) || 'Paired Pi'
                            : 'Paired Pi',
                    configured: picture.configured,
                    connected: picture.connected,
                    overloaded: picture.overloaded,
                    checkedAt: Date.now(),
                    lastFrameAt: picture.lastFrameAt,
                    isCurrent: () => current() && picture.isCurrent(),
                };
            })(),
            new Promise<never>((_, reject) => {
                onAbort = () => reject(new PiRadarError(expired ? 'unavailable' : 'cancelled'));
                controller.signal.addEventListener('abort', onAbort, { once: true });
                timer = setTimeout(() => {
                    expired = true;
                    controller.abort();
                }, 6000);
            }),
        ]);
    } catch (error) {
        guard();
        throw error instanceof PiRadarError ? error : new PiRadarError('unavailable');
    } finally {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', forward);
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
}
