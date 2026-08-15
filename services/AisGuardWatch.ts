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
 */
import { AisGuardZone } from './AisGuardZone';
import { AisStore } from './AisStore';
import { LocationStore } from '../stores/LocationStore';
import { NmeaStore } from './NmeaStore';
import { resolveOwnshipPosition } from './ownshipPosition';
import { useSettingsStore } from '../stores/settingsStore';
import { triggerHaptic } from '../utils/system';
import { createLogger } from '../utils/createLogger';

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

/**
 * One pass of the guard. Exported for tests — it is pure with respect to
 * everything except the stores it reads and the event it dispatches.
 */
export function runGuardCheck(nowMs: number = Date.now()): number {
    const gz = AisGuardZone.getState();
    if (!gz.enabled) return 0;

    const own = resolveOwnshipPosition(NmeaStore.getState(), LocationStore.getState(), nowMs);
    // No fix means no ring and no geometry — not an alert-free sea.
    if (!own) return 0;

    const local = AisStore.toGeoJSON().features;
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

    const alerts = AisGuardZone.checkFeatures(own.lat, own.lon, features, ownVesselMmsi());
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
