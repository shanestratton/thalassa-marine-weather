/**
 * DistressAlarmService — the distress alarm (build 125, package 125-02).
 *
 * An AIS-SART (a liferaft's), an AIS man-overboard beacon or an EPIRB-AIS
 * that the boat's own radio hears going active sounds at any range. The watch
 * (services/AisGuardWatch.ts) runs a pass on every AIS report and every few
 * seconds, whether or not the guard shield is armed: a beacon is not a
 * collision target and needs no arming.
 *
 *  - CLASSIFIED by the one pure rule (utils/collisionRule.ts classifyDistress,
 *    which the Pi copies in 126-04): status 14 or an ACTIVE text alarms;
 *    status 15 or a TEST text never does; a 97x with another status is a
 *    silent caution.
 *  - ONLY HER OWN RADIO SOUNDS. A beacon seen only over the internet (the
 *    chart's feed reaches about 100 NM, and any signed-in account can feed
 *    the fleet) is drawn red and carded silently with its age, never sounded:
 *    a far-off or spoofed 970 must not make every phone blare.
 *  - SOUND through AlarmAudioService under its own 'distress-watch' lease.
 *    Leases are owner-scoped, so the anchor alarm keeps priority (this path
 *    never force-stops), and the collision alarm and this one never fight:
 *    the sound plays while either holds it. Distress cards sit above
 *    collision cards.
 *  - THE LOCK SCREEN through the shared safety-notification path
 *    (AnchorSafetyNotificationService, kind 'distress', its own
 *    thalassa.distress-watch.* ids), Time Sensitive.
 *  - SILENCE stops the sound and the lock-screen reminders and keeps the card
 *    and the chart symbol. A new beacon, or one switched from test to active,
 *    sounds again. There is no per-target mute.
 *  - NEVER VANISHES: the store never drops a beacon, and an internet-relayed
 *    active one is kept, with its growing age, after it leaves the feed.
 *
 * DSC distress from the VHF is not here (it waits on the wiring, 126-04).
 */
import { AlarmAudioService } from './AlarmAudioService';
import { AnchorSafetyNotificationService } from './AnchorSafetyNotificationService';
import { AisGuardAlertStore, distressLines, type DistressBeacon } from './aisGuardAlertStore';
import { AisStore } from './AisStore';
import type { AisTarget } from '../types/navigation';
import { aisTargetIsDistressBeacon, classifyDistress, rangeBearing } from '../utils/collisionRule';
import { createLogger } from '../utils/createLogger';

const log = createLogger('DistressAlarm');

const LEASE_OWNER = 'distress-watch';

export interface DistressPassInputs {
    /** Her own position (vessel GPS first, else the phone), or null without a fix. */
    own: { lat: number; lon: number } | null;
    /** Our own MMSIs: never a beacon. */
    ownMmsis: ReadonlySet<number>;
    /** The chart's internet AIS features, as the guard holds them (fresh, or none). */
    internet: GeoJSON.Feature[];
    nowMs: number;
}

/** Internet-relayed active beacons, kept with their last report after they leave the feed. */
const cloudKept = new Map<number, DistressBeacon>();

function validPosition(lat: unknown, lon: unknown): boolean {
    return (
        typeof lat === 'number' &&
        typeof lon === 'number' &&
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        !(lat === 0 && lon === 0)
    );
}

function withRange(b: Omit<DistressBeacon, 'rangeNm' | 'bearingDeg'>, own: DistressPassInputs['own']): DistressBeacon {
    if (!own || b.lat === null || b.lon === null) return { ...b, rangeNm: null, bearingDeg: null };
    const { rangeNm, bearingDeg } = rangeBearing(own.lat, own.lon, b.lat, b.lon);
    return { ...b, rangeNm, bearingDeg };
}

function featureHeardAt(p: Record<string, unknown>, nowMs: number): number {
    const at = typeof p.updatedAt === 'string' && p.updatedAt ? Date.parse(p.updatedAt) : Number(p.lastUpdated);
    if (Number.isFinite(at) && at > 0) return Math.min(nowMs, at);
    const stale = Number(p.staleMinutes);
    return Number.isFinite(stale) ? nowMs - stale * 60_000 : nowMs;
}

/**
 * Every beacon in view this pass: those her own radio heard (the store, which
 * never drops one, message 14 texts heard before any position included), then
 * the internet's, where her radio has not heard the same MMSI.
 */
export function collectDistressBeacons({ own, ownMmsis, internet, nowMs }: DistressPassInputs): DistressBeacon[] {
    const out = new Map<number, DistressBeacon>();
    const targets = AisStore.getTargets();
    const texts = AisStore.getSafetyTexts();

    const local = (mmsi: number, target: AisTarget | undefined) => {
        if (ownMmsis.has(mmsi)) return;
        const positioned = !!target && validPosition(target.lat, target.lon);
        const text = texts.get(mmsi);
        // A beacon heard before its GNSS fix reports its status with no
        // position (the decoder and the Pi lane keep it): 14 counts. Without
        // a position, 15 does not: an unfixed beacon in test stays a caution
        // until its fix arrives. A status nobody reported is null (125-10b).
        const status = target && (positioned || target.navStatus !== 15) ? target.navStatus : null;
        const c = classifyDistress({
            mmsi,
            navStatus: status,
            navStatusAt: status === null ? null : target!.lastUpdated,
            safetyText: text?.text ?? null,
            safetyTextAt: text?.at ?? null,
            source: 'local',
            hasPosition: positioned,
        });
        if (!c) return;
        out.set(
            mmsi,
            withRange(
                {
                    mmsi,
                    name: target?.name ?? '',
                    kind: c.kind,
                    state: c.state,
                    source: 'local',
                    sounds: c.sounds,
                    lat: positioned ? target!.lat : null,
                    lon: positioned ? target!.lon : null,
                    heardAt: Math.max(target?.lastUpdated ?? 0, text?.at ?? 0),
                },
                own,
            ),
        );
    };
    for (const [mmsi, target] of targets) {
        if (aisTargetIsDistressBeacon(mmsi, target.navStatus) || texts.has(mmsi)) local(mmsi, target);
    }
    for (const mmsi of texts.keys()) if (!targets.has(mmsi)) local(mmsi, undefined);

    const relayedNow = new Set<number>();
    for (const f of internet) {
        const p = (f.properties ?? {}) as Record<string, unknown>;
        if (p.source !== 'cloud') continue;
        const mmsi = Number(p.mmsi);
        const coords = (f.geometry as GeoJSON.Point | undefined)?.coordinates;
        if (!Number.isFinite(mmsi) || out.has(mmsi) || ownMmsis.has(mmsi) || !coords) continue;
        const [lon, lat] = [Number(coords[0]), Number(coords[1])];
        if (!validPosition(lat, lon)) continue;
        const heardAt = featureHeardAt(p, nowMs);
        const c = classifyDistress({
            mmsi,
            navStatus: Number(p.navStatus ?? p.nav_status),
            navStatusAt: heardAt,
            source: 'cloud',
            hasPosition: true,
        });
        if (!c) continue;
        relayedNow.add(mmsi);
        const beacon = withRange(
            {
                mmsi,
                name: typeof p.name === 'string' ? p.name : '',
                kind: c.kind,
                state: c.state,
                source: 'cloud',
                sounds: false,
                lat,
                lon,
                heardAt,
            },
            own,
        );
        out.set(mmsi, beacon);
        if (c.state === 'active') cloudKept.set(mmsi, beacon);
        else cloudKept.delete(mmsi);
    }
    // A relayed active beacon gone from the feed (the chart closed, or out of
    // its window) stays with its last report and a growing age.
    for (const [mmsi, kept] of cloudKept) {
        if (out.has(mmsi)) {
            if (out.get(mmsi)!.source === 'local') cloudKept.delete(mmsi);
            continue;
        }
        if (!relayedNow.has(mmsi)) out.set(mmsi, withRange(kept, own));
    }
    return [...out.values()].sort((a, b) => a.mmsi - b.mmsi);
}

let sounding = new Set<number>();
let leaseToken: string | null = null;
let soundWanted = false;
let alertLive = false;
let tail: Promise<void> = Promise.resolve();

function run(operation: () => Promise<void>): void {
    tail = tail.then(operation).catch((error) => log.warn('distress alarm side effect failed:', error));
}

function lockScreenBody(b: DistressBeacon): string {
    const lines = distressLines(b);
    const who = `MMSI ${b.mmsi}${b.name ? ` (${b.name})` : ''}`;
    if (!lines.canGoTo) return `${who}, position not yet received, heard by your radio.`;
    if (b.rangeNm === null || b.bearingDeg === null) {
        return `${who}, heard by your radio. Range unknown: no position fix. Open Thalassa to go to it.`;
    }
    const where = lines.where.replace(' · ', ', ');
    return `${who}, ${where} from you, heard by your radio. Open Thalassa to go to it.`;
}

/** What sounds now, from the beacons in the store and the skipper's Silence. */
function reconcile(): void {
    const wanted = AisGuardAlertStore.getDistress().filter((b) => AisGuardAlertStore.distressSounding(b));
    const fresh = wanted.find((b) => !sounding.has(b.mmsi));
    sounding = new Set(wanted.map((b) => b.mmsi));
    const wantSound = wanted.length > 0;
    // Runs on every AIS report: queue work only when something changes.
    if (!fresh && wantSound === soundWanted && !(wantSound && leaseToken === null)) return;
    soundWanted = wantSound;

    run(async () => {
        if (soundWanted && !leaseToken) {
            leaseToken = await AlarmAudioService.acquire(LEASE_OWNER).catch((error) => {
                log.warn('distress alarm audio could not start:', error);
                return null;
            });
        } else if (!soundWanted && leaseToken) {
            const token = leaseToken;
            leaseToken = null;
            await AlarmAudioService.release(token).catch(() => AlarmAudioService.releaseEventually(token));
        }

        if (fresh && sounding.has(fresh.mmsi)) {
            alertLive = true;
            await AnchorSafetyNotificationService.scheduleSafetyAlert(
                'distress',
                distressLines(fresh).alert,
                lockScreenBody(fresh),
            ).catch((error) => log.warn('distress lock-screen alert could not be scheduled:', error));
        } else if (!soundWanted && alertLive) {
            // Silenced in the app: the lock-screen reminders have done their job.
            alertLive = false;
            await AnchorSafetyNotificationService.cancelSafetyAlert('distress').catch((error) =>
                log.warn('distress lock-screen alert could not be withdrawn:', error),
            );
        }
    });
}

AisGuardAlertStore.subscribeActions(() => reconcile());

export const DistressAlarmService = {
    /** One pass of the watch: every beacon it classified. */
    update(beacons: DistressBeacon[], nowMs: number): void {
        AisGuardAlertStore.setDistress(beacons, nowMs);
        reconcile();
    },

    /** Test seam: resolves once every queued side effect has run. */
    whenIdle(): Promise<void> {
        return tail;
    },

    /** Test seam. */
    __resetForTests(): void {
        sounding = new Set();
        leaseToken = null;
        soundWanted = false;
        alertLive = false;
        cloudKept.clear();
        tail = Promise.resolve();
    },
};
