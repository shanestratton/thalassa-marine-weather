/**
 * Which of this phone's receivers produced a fix: its own chip ('phone'), or
 * a Bad Elf / MFi accessory feeding Core Location ('phone-accessory').
 *
 * Asked per fix, not once at Start (build 123 review): a Bad Elf whose
 * battery dies mid-passage hands Core Location back to the phone's chip, and
 * every point after that is the chip's. iOS says which receiver produced the
 * engine's latest location (CLLocationSourceInformation.isProducedByAccessory,
 * read by BackgroundLocationPlugin.getActiveLocationSource). That answer is
 * read at most every REFRESH_MS — a native call on the shared plugin queue,
 * never one per fix — and it vouches for a fix only when it describes a
 * location within MATCH_MS of it. Anything less is the phone: an accessory
 * is claimed only when it is confirmed live.
 */
import type { CachedPosition } from '../BgGeoManager';

/** Read iOS's receiver provenance at most this often. */
const REFRESH_MS = 15_000;
/** A provenance answer vouches only for fixes this close to the location it describes. */
const MATCH_MS = 45_000;

export interface ReceiverSample {
    externalAccessory: boolean;
    /** When the location the answer describes was fixed (epoch-ms), or null. */
    timestampMs: number | null;
}

async function readReceiver(): Promise<ReceiverSample | null> {
    const { BackgroundLocationService } = await import('../BackgroundLocationService');
    const info = await BackgroundLocationService.getGpsReceiverInfo();
    return info?.source
        ? { externalAccessory: info.source.externalAccessory, timestampMs: info.source.timestampMs }
        : null;
}

export function createPhoneFixClassifier(
    read: () => Promise<ReceiverSample | null> = readReceiver,
    clock: () => number = Date.now,
): { classify: (pos: CachedPosition, isNative: boolean) => 'phone' | 'phone-accessory' } {
    let sample: ReceiverSample | null = null;
    let readAt = Number.NEGATIVE_INFINITY;
    let inFlight = false;

    const refresh = () => {
        if (inFlight || clock() - readAt < REFRESH_MS) return;
        inFlight = true;
        readAt = clock();
        void read()
            .then((next) => {
                sample = next;
            })
            .catch(() => {
                sample = null;
            })
            .finally(() => {
                inFlight = false;
            });
    };

    return {
        classify(pos, isNative) {
            if (!isNative) return 'phone';
            refresh();
            const s = sample;
            const vouched =
                s?.externalAccessory === true &&
                s.timestampMs !== null &&
                Number.isFinite(pos.timestamp) &&
                Math.abs(pos.timestamp - s.timestampMs) <= MATCH_MS;
            return vouched ? 'phone-accessory' : 'phone';
        },
    };
}
