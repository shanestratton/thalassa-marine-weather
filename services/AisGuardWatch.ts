/**
 * AisGuardWatch — the collision guard actually watching.
 *
 * WHY THIS EXISTS. The only production call to AisGuardZone.checkFeatures used
 * to live inside useAisStreamLayer's mergeAndWrite, behind:
 *
 *     if (!map || !enabled) return;
 *
 * where `enabled` is the AIS *layer visibility* flag. So the collision guard
 * only watched while the AIS layer happened to be drawn. Switching to Storms
 * or Squall silently killed it — buildTacticalState treats those as mutually
 * exclusive and calls setAisVisible(false) — as did displaying a passage,
 * because useMapHubLayerVisibility drops AIS whenever planningSurface is true.
 * And leaving the chart entirely stopped it too, since the hook unmounts.
 *
 * The armed state persists on its own storage key, so the shield kept showing
 * red "2 NM" throughout. A collision-avoidance feature that reports itself as
 * ON while watching nothing is worse than one that is plainly off: it earns
 * trust it is not honouring. Found in the 2026-08-13 lockdown sweep.
 *
 * So the watch now lives here — mounted for the life of the app, independent
 * of any map, layer, tab or route.
 *
 * WHAT IT WATCHES. The boat's own AIS receiver (AisStore), always. Those are
 * the targets that matter for collision avoidance: seconds old, straight off
 * the transponder, no shore station or network in the path. When the chart's
 * internet layer happens to be running it also hands over its merged set, so
 * coverage is never narrower than it was before — but internet AIS going
 * quiet can no longer stop the guard, because it never was the safety-
 * critical source.
 *
 * THE COLLISION ALARM (build 125, 125-01) rides the same pass: every target is
 * graded with the one collision rule (utils/collisionRule.ts) the chart's CPA
 * chip uses, and CollisionAlarmService decides what sounds. Only real
 * sensors alarm (the boat's receiver, network AIS); an unknown speed or course
 * is range-only; our own course and speed come from her GPS, else the phone;
 * our own transponder (the MMSI in Settings → Vessel, or the one her !AIVDO
 * reports) is never a target. readCollisionInputs is the one place those
 * inputs are read, so the chip and Calypso grade with exactly what the alarm
 * does. A shield armed before build 125 keeps its ring but waits for the
 * collision sound check before it sounds.
 */
import { AisGuardZone } from './AisGuardZone';
import { AisStore } from './AisStore';
import { LocationStore } from '../stores/LocationStore';
import { NmeaStore } from './NmeaStore';
import { GpsService } from './GpsService';
import { resolveOwnMotion, resolveOwnshipPosition, type OwnMotion } from './ownshipPosition';
import { useSettingsStore } from '../stores/settingsStore';
import { triggerHaptic } from '../utils/system';
import { createLogger } from '../utils/createLogger';
import {
    aisCogDeg,
    aisSogKn,
    assessCollision,
    collisionOpening,
    collisionSourceCanAlarm,
    ownMotionState,
    sanitiseCollisionPrefs,
    type CollisionPrefs,
} from '../utils/collisionRule';
import { CollisionAlarmService, type CollisionAlarmCandidate } from './CollisionAlarmService';

const log = createLogger('AisGuardWatch');

/** Re-check on a timer as well as on receiver updates: a target already
 *  inside the ring that stops reporting must not fall out of the check
 *  simply because no new frame arrived. */
const TICK_MS = 5_000;

/** Internet features are only as good as their last delivery. If the chart
 *  layer stops feeding us (unmounted, hidden, offline) we drop them rather
 *  than checking against an ever-staler snapshot. Local targets carry on. */
const INTERNET_FEED_TTL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribeStore: (() => void) | null = null;
let started = false;

let internetFeatures: GeoJSON.Feature[] = [];
let internetFeaturesAt = 0;

function ownVesselMmsi(): number | undefined {
    const raw = Number(useSettingsStore.getState().settings?.vessel?.mmsi);
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/** Our own MMSIs: the one in Settings → Vessel and the one our transponder reports (!AIVDO). */
function ownMmsis(): Set<number> {
    const out = new Set<number>();
    const typed = ownVesselMmsi();
    if (typed !== undefined) out.add(typed);
    const heard = AisStore.getOwnMmsi();
    if (typeof heard === 'number' && heard > 0) out.add(heard);
    return out;
}

/** Everything the collision rule needs about us, read once, the same way for the alarm, the chip and Calypso. */
export interface CollisionInputs {
    /** 'nmea' is the boat's own GPS (any lane), 'gps' this phone. */
    own: { lat: number; lon: number; source: 'nmea' | 'gps' } | null;
    motion: OwnMotion;
    prefs: CollisionPrefs;
    ownMmsis: Set<number>;
}

export function readCollisionInputs(nowMs: number = Date.now()): CollisionInputs {
    const own = resolveOwnshipPosition(NmeaStore.getState(), LocationStore.getState(), nowMs);
    return {
        own: own ? { lat: own.lat, lon: own.lon, source: own.source } : null,
        motion: resolveOwnMotion(NmeaStore.getState(), GpsService.getLastKnownPosition(), nowMs),
        prefs: sanitiseCollisionPrefs(useSettingsStore.getState().settings?.collisionAlarm),
        ownMmsis: ownMmsis(),
    };
}

/** Seconds since the report a feature's position came from, or null. */
function reportAgeSec(p: Record<string, unknown>, nowMs: number): number | null {
    const at = typeof p.updatedAt === 'string' && p.updatedAt ? Date.parse(p.updatedAt) : Number(p.lastUpdated);
    if (Number.isFinite(at) && at > 0) return Math.max(0, Math.round((nowMs - at) / 1000));
    const stale = Number(p.staleMinutes);
    return p.staleMinutes != null && Number.isFinite(stale) ? Math.round(stale * 60) : null;
}

/**
 * Grade every target with the collision rule, alarming or not, so the alarm
 * can tell 'opening' from 'lost'. Exported for tests. Source is whatever
 * tagged the feature: 'local' for the receiver, 'cloud' for network AIS —
 * anything else (an app-shared position) is never graded for the alarm, and
 * our own MMSIs never are.
 */
export function gradeCollisionTargets(
    own: { lat: number; lon: number },
    motion: OwnMotion,
    features: GeoJSON.Feature[],
    prefs: CollisionPrefs,
    ownMmsi: number | ReadonlySet<number> | undefined,
    nowMs: number,
): CollisionAlarmCandidate[] {
    const isOwn = (mmsi: number) => (typeof ownMmsi === 'number' ? mmsi === ownMmsi : !!ownMmsi?.has(mmsi));
    const out: CollisionAlarmCandidate[] = [];
    for (const f of features) {
        const p = f.properties ?? {};
        const mmsi = Number(p.mmsi);
        const coords = (f.geometry as GeoJSON.Point | undefined)?.coordinates;
        if (!Number.isFinite(mmsi) || mmsi <= 0 || isOwn(mmsi) || !coords) continue;
        const source = typeof p.source === 'string' ? p.source : null;
        if (!collisionSourceCanAlarm(source)) continue;
        const age = reportAgeSec(p, nowMs);
        const sogKn = aisSogKn(p.sog);
        const assessment = assessCollision(
            { lat: own.lat, lon: own.lon, sogKn: motion.sogKn, cogDeg: motion.cogDeg, pair: motion.pair },
            {
                lat: Number(coords[1]),
                lon: Number(coords[0]),
                sogKn,
                cogDeg: aisCogDeg(p.cog),
                navStatus: Number(p.navStatus ?? p.nav_status),
                reportAgeSec: age,
                source,
            },
            prefs,
        );
        if (!assessment) continue;
        out.push({
            mmsi,
            name: p.name ? String(p.name) : `MMSI ${mmsi}`,
            assessment,
            reportAgeSec: age,
            source: String(source),
            sogKn,
            opening: collisionOpening(assessment, prefs),
        });
    }
    return out;
}

/** The alarming targets only (gradeCollisionTargets, filtered). Exported for tests and Calypso's checks. */
export function collisionCandidates(
    own: { lat: number; lon: number },
    motion: OwnMotion,
    features: GeoJSON.Feature[],
    prefs: CollisionPrefs,
    ownMmsi: number | ReadonlySet<number> | undefined,
    nowMs: number,
): CollisionAlarmCandidate[] {
    return gradeCollisionTargets(own, motion, features, prefs, ownMmsi, nowMs).filter((c) => c.assessment.alarm);
}

/** The newest report among the targets we hold (0 = none); the store's own clock covers the rest. */
function newestReportAt(features: GeoJSON.Feature[], nowMs: number): number {
    let newest = 0;
    for (const f of features) {
        const age = reportAgeSec(f.properties ?? {}, nowMs);
        if (age !== null) newest = Math.max(newest, nowMs - age * 1000);
    }
    return newest;
}

/**
 * One pass of the guard. Exported for tests — it is pure with respect to
 * everything except the stores it reads and the event it dispatches.
 */
export function runGuardCheck(nowMs: number = Date.now()): number {
    const gz = AisGuardZone.getState();
    if (!gz.enabled) {
        CollisionAlarmService.disarm();
        return 0;
    }

    const inputs = readCollisionInputs(nowMs);
    const own = inputs.own;
    // A shield armed before build 125 never ran the collision sound check:
    // its ring keeps working, and the collision alarm waits until it has.
    const collisionArmed = gz.collisionChecked === true;
    // No fix means no ring and no geometry — not an alert-free sea.
    if (!own) {
        if (collisionArmed) CollisionAlarmService.noFix(nowMs);
        else CollisionAlarmService.unchecked(nowMs);
        return 0;
    }

    // Receiver targets are tagged 'local': the boat's own radio heard them.
    const local = AisStore.toGeoJSON().features.map((f) => ({
        ...f,
        properties: { ...f.properties, source: 'local' },
    })) as GeoJSON.Feature[];
    const internetFresh = nowMs - internetFeaturesAt <= INTERNET_FEED_TTL_MS ? internetFeatures : [];

    // Receiver targets win an MMSI collision, exactly as the chart merge and
    // the anchor radar do: same vessel, fresher truth.
    const seen = new Set<number>();
    const features: GeoJSON.Feature[] = [];
    for (const f of local) {
        const mmsi = Number(f.properties?.mmsi);
        if (Number.isFinite(mmsi)) seen.add(mmsi);
        features.push(f);
    }
    for (const f of internetFresh) {
        const mmsi = Number(f.properties?.mmsi);
        if (Number.isFinite(mmsi) && seen.has(mmsi)) continue;
        features.push(f);
    }

    if (collisionArmed) {
        CollisionAlarmService.update(
            gradeCollisionTargets(own, inputs.motion, features, inputs.prefs, inputs.ownMmsis, nowMs),
            {
                nowMs,
                // When AIS was last HEARD by any lane: any decoded message (our own
                // transponder's and static ones too), not just the targets still held.
                lastAisAt: Math.max(newestReportAt(features, nowMs), AisStore.getLastHeardAt()),
                own: ownMotionState(inputs.motion.sogKn, inputs.motion.cogDeg),
            },
        );
    } else {
        CollisionAlarmService.unchecked(nowMs);
    }

    // The ring never alarms on our own transponder either, typed or heard.
    const ringFeatures =
        inputs.ownMmsis.size === 0
            ? features
            : features.filter((f) => !inputs.ownMmsis.has(Number(f.properties?.mmsi)));
    const alerts = AisGuardZone.checkFeatures(own.lat, own.lon, ringFeatures, ownVesselMmsi());
    if (alerts.length > 0) {
        triggerHaptic('heavy');
        try {
            window.dispatchEvent(new CustomEvent('ais-guard-alert', { detail: alerts }));
        } catch {
            /* non-DOM host */
        }
    }
    return alerts.length;
}

/**
 * The chart's internet AIS layer offers its merged feature set here while it
 * is running. Purely additive — the guard never depends on it.
 */
export function publishInternetAisFeatures(features: GeoJSON.Feature[]): void {
    internetFeatures = features;
    internetFeaturesAt = Date.now();
}

/** Start the app-wide watch. Idempotent; returns the stopper. */
export function startAisGuardWatch(): () => void {
    if (started) return stopAisGuardWatch;
    started = true;

    // Receiver updates drive it, so a target entering the ring is caught on
    // arrival rather than up to TICK_MS later.
    unsubscribeStore = AisStore.subscribe(() => {
        try {
            runGuardCheck();
        } catch (error) {
            log.warn('guard check failed on AIS update:', error);
        }
    });

    timer = setInterval(() => {
        try {
            runGuardCheck();
        } catch (error) {
            log.warn('guard check failed on tick:', error);
        }
    }, TICK_MS);

    log.info('collision guard watch started — independent of chart layer visibility');
    return stopAisGuardWatch;
}

export function stopAisGuardWatch(): void {
    if (timer) clearInterval(timer);
    timer = null;
    if (unsubscribeStore) unsubscribeStore();
    unsubscribeStore = null;
    internetFeatures = [];
    internetFeaturesAt = 0;
    started = false;
}

/** Test seam. */
export function __resetAisGuardWatchForTests(): void {
    stopAisGuardWatch();
}
