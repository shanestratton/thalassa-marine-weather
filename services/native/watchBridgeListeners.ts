/**
 * watchBridgeListeners — wires the Apple Watch's reverse-direction
 * events (MOB trigger, alarm acknowledge) and the weather-snapshot push
 * stream into the long-running TS services.
 *
 * Bootstrapped from `index.tsx` so the listeners are alive for the
 * whole session. No-op on web / non-iOS.
 *
 * What this owns:
 *
 *   1. **Watch → MOB**: subscribes to the watch's `mobTriggered` event
 *      and asks `MobService.activate()` to mark a MOB fix in Thalassa.
 *      This does not transmit a DSC distress alert or a voice Mayday.
 *
 *   2. **Watch → Anchor alarm acknowledge**: subscribes to `alarmAck`
 *      and calls `AnchorWatchService.acknowledgeAlarm()`. Watch delivery
 *      only proves the phone received the request; the Watch UI keeps
 *      phone-audio status qualified accordingly.
 *
 *   3. **Phone → Watch cockpit data**: subscribes to `useWeatherStore`
 *      and polls current SOG/COG from `ShipLogService`. Changed values
 *      push promptly; an unchanged-data heartbeat refreshes generatedAt
 *      so the Watch can distinguish live data from durable stale context.
 */
import { Capacitor } from '@capacitor/core';
import { toast } from '../../components/Toast';
import { createLogger } from '../../utils/createLogger';
import { useWeatherStore } from '../../stores/weatherStore';
import { onMobTriggered, onAlarmAck, pushWeatherSnapshot, type WatchWeatherSnapshot } from './watchBridge';
import { claimWatchMobRequest, evaluateWatchMobRequest, type WatchMobRequestRejection } from './watchMobRequestSafety';

const log = createLogger('watchBridgeListeners');

let initialized = false;
let weatherUnsub: (() => void) | null = null;
let weatherHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Idempotent boot — call once from `index.tsx` after Sentry + Capacitor
 * are up. Subsequent calls are no-ops, so HMR / accidental re-mounts
 * don't double-subscribe.
 */
export async function initWatchBridgeListeners(): Promise<void> {
    if (initialized) return;
    initialized = true;

    // No-op on web / Android — the bridge's own platform check makes the
    // calls harmless, but skipping the wiring keeps the service module
    // (lazy-loaded MobService etc.) off the web bundle's critical path.
    if (Capacitor.getPlatform() !== 'ios') return;

    await Promise.all([wireMobTrigger(), wireAlarmAck()]);
    wireWeatherPush();
}

// ── Watch → MOB ──────────────────────────────────────────────────────

function warnRejectedWatchMobRequest(reason: WatchMobRequestRejection): void {
    if (reason === 'expired') {
        toast.persistentError(
            'Apple Watch MOB request expired and was NOT marked. Use the phone MOB control now and use VHF/DSC for distress.',
        );
        return;
    }

    toast.persistentError(
        'Apple Watch MOB request could not be verified and was NOT marked. Use the phone MOB control now and use VHF/DSC for distress.',
    );
}

async function handleWatchMobRequest(event: Record<string, unknown>): Promise<void> {
    let decision = evaluateWatchMobRequest(event);

    // Reserve every structurally identifiable request before acting — even an
    // already-expired one. That prevents the immediate and queued WCSession
    // copies from producing two markers or two alarming rejection messages.
    if (decision.requestId) {
        try {
            const claim = await claimWatchMobRequest(decision.requestId);
            if (claim.duplicate) {
                log.info('ignored duplicate Watch MOB request', {
                    requestId: decision.requestId,
                    deliveryChannel: event.deliveryChannel,
                });
                return;
            }
            if (!claim.durable) {
                log.warn('Watch MOB request dedupe could not be persisted; in-process reservation remains active');
            }
        } catch (error) {
            // A reservation failure we did not explicitly contain means we
            // cannot prove this is not the second delivery. Fail closed rather
            // than risk moving a recently-cleared casualty datum.
            log.warn('Watch MOB request could not be reserved safely', error);
            warnRejectedWatchMobRequest('invalid-envelope');
            return;
        }
    }

    if (!decision.accepted) {
        log.warn('rejected Watch MOB request', { reason: decision.reason, deliveryChannel: event.deliveryChannel });
        warnRejectedWatchMobRequest(decision.reason);
        return;
    }

    // Preferences and bridge scheduling are asynchronous. Recheck immediately
    // before asking MobService for the phone's current position so a request
    // cannot cross the 15-second boundary while waiting to be claimed.
    decision = evaluateWatchMobRequest(event);
    if (!decision.accepted) {
        log.warn('Watch MOB request expired while awaiting dedupe reservation');
        warnRejectedWatchMobRequest(decision.reason);
        return;
    }

    log.info('fresh Watch MOB request → activating MobService', {
        requestId: decision.requestId,
        deliveryChannel: decision.deliveryChannel,
    });
    // Lazy import so the phone-side marker/tracking dependency tree
    // does not load until the user deliberately requests it.
    const { MobService } = await import('../MobService');
    try {
        const marked = await MobService.activate();
        if (!marked) {
            log.warn('Watch MOB request reached the phone, but no GPS fix was available to mark');
            toast.persistentError(
                'Apple Watch MOB request arrived, but phone GPS was unavailable. MOB was NOT marked — use the phone control or chartplotter now.',
            );
            return;
        }
        toast.info('Apple Watch MOB request received — confirm the active marker and use VHF/DSC for distress.', 8_000);
    } catch (error) {
        log.warn('MobService.activate() threw', error);
        toast.persistentError(
            'Apple Watch MOB request could not create a phone marker. Use the phone MOB control or chartplotter now.',
        );
    }
}

async function wireMobTrigger(): Promise<void> {
    try {
        await onMobTriggered(handleWatchMobRequest);
    } catch (e) {
        log.warn('onMobTriggered subscribe failed', e);
    }
}

// ── Watch → Anchor alarm acknowledge ─────────────────────────────────

async function wireAlarmAck(): Promise<void> {
    try {
        await onAlarmAck(async () => {
            log.info('watch requested phone drag-alarm acknowledgement');
            const { AnchorWatchService } = await import('../AnchorWatchService');
            try {
                await AnchorWatchService.acknowledgeAlarm();
            } catch (e) {
                log.warn('AnchorWatchService.acknowledgeAlarm() threw', e);
            }
        });
    } catch (e) {
        log.warn('onAlarmAck subscribe failed', e);
    }
}

// ── Phone → Watch weather snapshot push ──────────────────────────────

/**
 * Changed cockpit values push immediately. Even if the values do not
 * change, a heartbeat is sent at least once a minute while the phone
 * app is running; without it a durable application context can look
 * current on the Watch indefinitely after the phone stops updating.
 */
const WEATHER_POLL_MS = 30_000;
const WEATHER_HEARTBEAT_MS = 60_000;
const WEATHER_SOURCE_MAX_AGE_MS = 60 * 60_000;
let lastPushKey = '';
let lastPushAt = 0;
let weatherPushInFlight = false;

function buildSnapshotKey(s: WatchWeatherSnapshot): string {
    return [s.windKts, s.windDirDeg, s.gustKts ?? '', s.headingDeg ?? '', s.sogKts ?? '', s.pressureHpa ?? ''].join(
        '|',
    );
}

async function pushCurrentWeatherSnapshot(forceHeartbeat = false): Promise<void> {
    if (weatherPushInFlight) return;
    const weather = useWeatherStore.getState().weatherData;
    if (!weather) return;

    const now = Date.now();
    const weatherGeneratedAt = Date.parse(weather.generatedAt);
    const weatherSourceAge = now - weatherGeneratedAt;
    // A phone-runtime heartbeat must not launder an old/offline forecast into
    // a fresh-looking Watch wind value. Stop pushing and let the Watch's
    // two-minute age gate hide the durable context.
    if (
        weather._stale === true ||
        !Number.isFinite(weatherGeneratedAt) ||
        weatherSourceAge < -5 * 60_000 ||
        weatherSourceAge > WEATHER_SOURCE_MAX_AGE_MS
    ) {
        return;
    }

    weatherPushInFlight = true;
    try {
        // Pull current SOG/COG independently of weather-store changes. This
        // polling only runs while the phone web runtime is alive.
        let sogKts: number | undefined;
        let cogDeg: number | undefined;
        try {
            const { ShipLogService } = await import('../ShipLogService');
            const nav = ShipLogService.getGpsNavData();
            sogKts = nav.sogKts ?? undefined;
            cogDeg = nav.cogDeg ?? undefined;
        } catch {
            /* ShipLogService unavailable — SOG/COG remain explicitly absent. */
        }

        const cur = weather.current;
        const windKts = cur.windSpeed;
        const windDeg = cur.windDegree;
        if (windKts === null || windKts === undefined || windDeg === null || windDeg === undefined) return;

        const snapshot: WatchWeatherSnapshot = {
            windKts,
            windDirDeg: windDeg,
            gustKts: cur.windGust ?? undefined,
            headingDeg: cogDeg,
            sogKts,
            pressureHpa: cur.pressure ?? undefined,
            generatedAt: now,
        };

        const key = buildSnapshotKey(snapshot);
        const heartbeatDue = now - lastPushAt >= WEATHER_HEARTBEAT_MS;
        if (key === lastPushKey && !forceHeartbeat && !heartbeatDue) return;

        try {
            await pushWeatherSnapshot(snapshot);
            lastPushKey = key;
            lastPushAt = now;
        } catch (e) {
            log.info('pushWeatherSnapshot failed (no watch?)', e);
        }
    } finally {
        weatherPushInFlight = false;
    }
}

function wireWeatherPush(): void {
    weatherUnsub = useWeatherStore.subscribe(
        (s) => s.weatherData,
        () => {
            void pushCurrentWeatherSnapshot();
        },
    );

    weatherHeartbeatTimer = setInterval(() => {
        void pushCurrentWeatherSnapshot();
    }, WEATHER_POLL_MS);

    // Cover an already-populated store when the bridge initializes.
    void pushCurrentWeatherSnapshot(true);

    // weatherUnsub captured above; we don't expose it externally — the
    // listener is meant to be one-shot for the session lifetime. Tests
    // call _resetForTests() to release it for re-init.
}

/** Focused test hook for the unchanged-data heartbeat contract. */
export async function _pushWeatherHeartbeatForTests(): Promise<void> {
    await pushCurrentWeatherSnapshot(true);
}

/**
 * Test/dev hook — resets the initialised flag so the listener wiring
 * can be re-bootstrapped. Not exported via the public barrel; only
 * tests should reach for it.
 */
export function _resetForTests(): void {
    if (weatherUnsub) {
        weatherUnsub();
        weatherUnsub = null;
    }
    if (weatherHeartbeatTimer) {
        clearInterval(weatherHeartbeatTimer);
        weatherHeartbeatTimer = null;
    }
    initialized = false;
    lastPushKey = '';
    lastPushAt = 0;
    weatherPushInFlight = false;
}
