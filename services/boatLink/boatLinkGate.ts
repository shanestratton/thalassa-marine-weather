/**
 * boatLinkGate — is there a boat link at all, and the boat-link service, loaded
 * only when there is (build 131, 131-01; was 126-10).
 *
 * BoatLinkService and its model are some 21 KB of a phone's start-up, and once
 * anything watches them a 2 s tick and a read of the phone's network. A phone
 * with no Pi paired and no gateway saved has no boat link to describe, so
 * nothing on the boot path loads it there: the instrument policy, the voyage
 * track's source plan, the System status button and the chart's wind field
 * ask this module, and get the service only for a boat that has one.
 *
 * A screen ABOUT the boat link (the NMEA Gateway page, the Vessel page row,
 * the Instrument Panel, Remote Access, the open System status box) loads it
 * when it opens, set up or not: a crew phone with neither still reads her
 * through the cloud, and "No gateway" is the service's to say, not this one's.
 *
 * Until it has loaded the answer is "checking": never "no boat", "not
 * connected" or a place. A boat with a Pi must not flash "No gateway" for the
 * moment the import takes.
 */
import { readSignalKDeviceConfig } from '../signalk/config';
import { NmeaListenerService } from '../NmeaListenerService';
import { getPairing } from '../PiPairingService';
import { createLogger } from '../../utils/createLogger';
import type { BoatLinkWords } from './boatLinkModel';

type BoatLink = typeof import('./BoatLinkService').BoatLinkService;

const log = createLogger('BoatLink');

let service: BoatLink | null = null;
let loading: Promise<BoatLink | null> | null = null;
const onLoad = new Set<() => void>();

/**
 * The words while the service loads, for a screen that would show its own:
 * "Checking…" in the place of "No gateway", "Not connected" or a place.
 */
export const BOAT_LINK_CHECKING: BoatLinkWords = {
    pill: { text: 'Checking…', tone: 'grey', place: null, placeTone: 'grey', data: 'Checking…', dataTone: 'grey' },
    line: null,
    whereNote: null,
    statusRow: 'Checking…',
    hub: { value: 'Checking…', status: 'Instruments & AIS', tone: 'grey' },
};

/** Any way to the boat's instruments: a Pi paired, or a gateway saved. Never throws. */
export function boatLinkConfigured(): boolean {
    try {
        return (
            getPairing() !== null ||
            NmeaListenerService.getSavedConfig() !== null ||
            readSignalKDeviceConfig()?.selected === true
        );
    } catch {
        return false;
    }
}

/** The service if it has loaded, else null. Never starts the load. */
export function loadedBoatLink(): BoatLink | null {
    return service;
}

/** Load the service, once. Null when it cannot load (a later call tries again). */
export function loadBoatLink(): Promise<BoatLink | null> {
    if (service) return Promise.resolve(service);
    if (!loading) {
        loading = import('./BoatLinkService')
            .then(({ BoatLinkService }) => {
                service = BoatLinkService;
                for (const attach of [...onLoad]) attach();
                return service;
            })
            .catch((error: unknown) => {
                log.warn('could not load:', error instanceof Error ? error.message : String(error));
                return null;
            })
            .finally(() => {
                loading = null;
            });
    }
    return loading;
}

/**
 * For boot-path code: the service if it has loaded, else null — and for a
 * boat with a Pi paired or a gateway saved the load starts now. Null is
 * "checking" (or no boat link), never "no boat".
 */
export function boatLinkIfConfigured(): BoatLink | null {
    if (service) return service;
    if (boatLinkConfigured()) void loadBoatLink();
    return null;
}

/**
 * Watch the snapshot, for a screen about the boat link: the load starts now if
 * it has not, and the watcher is told once when it lands, then on every change.
 */
export function watchBoatLink(listener: () => void): () => void {
    let unsubscribe: (() => void) | null = null;
    let stopped = false;
    const attach = () => {
        if (stopped || unsubscribe || !service) return;
        onLoad.delete(attach);
        unsubscribe = service.subscribe(listener);
        listener();
    };
    if (service) attach();
    else {
        onLoad.add(attach);
        void loadBoatLink();
    }
    return () => {
        stopped = true;
        onLoad.delete(attach);
        unsubscribe?.();
    };
}

/** Tests only: as though nothing had loaded it yet. */
export function resetBoatLinkGateForTests(): void {
    service = null;
    loading = null;
    onLoad.clear();
}
