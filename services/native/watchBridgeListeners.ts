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
 *      and routes it through `MobService.activate()` — the same code
 *      path the in-app red MOB button uses, so DSC + alarm + tracking
 *      all kick in identically regardless of which side fired it.
 *
 *   2. **Watch → Anchor alarm acknowledge**: subscribes to `alarmAck`
 *      and calls `AnchorWatchService.acknowledgeAlarm()`. Lets the
 *      skipper silence the drag alarm from the wrist without unlocking
 *      the phone.
 *
 *   3. **Phone → Watch weather**: subscribes to `useWeatherStore` and
 *      `BoatNetworkService` (for SOG/COG via GPS) and pushes a
 *      `WatchWeatherSnapshot` whenever the weather report or the
 *      navigation data updates. Coalesced so we don't drown the watch
 *      with tiny updates — only push when something the cockpit-glance
 *      view actually displays has changed.
 */
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';
import { useWeatherStore } from '../../stores/weatherStore';
import { onMobTriggered, onAlarmAck, pushWeatherSnapshot, type WatchWeatherSnapshot } from './watchBridge';

const log = createLogger('watchBridgeListeners');

let initialized = false;
let weatherUnsub: (() => void) | null = null;

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

async function wireMobTrigger(): Promise<void> {
    try {
        await onMobTriggered(async () => {
            log.info('watch fired mobTriggered → activating MobService');
            // Lazy import so the MobService dependency tree (including
            // DSC + audio alarm) doesn't load until we actually need it.
            const { MobService } = await import('../MobService');
            try {
                await MobService.activate();
            } catch (e) {
                log.warn('MobService.activate() threw', e);
            }
        });
    } catch (e) {
        log.warn('onMobTriggered subscribe failed', e);
    }
}

// ── Watch → Anchor alarm acknowledge ─────────────────────────────────

async function wireAlarmAck(): Promise<void> {
    try {
        await onAlarmAck(async () => {
            log.info('watch fired alarmAck → silencing drag alarm');
            const { AnchorWatchService } = await import('../AnchorWatchService');
            try {
                AnchorWatchService.acknowledgeAlarm();
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
 * Coalescing: zustand's subscribeWithSelector fires on every
 * weatherData object identity change, but only some changes are
 * cockpit-relevant. We additionally compare a synthesised key so
 * we don't burn battery pushing nothing-changed snapshots when the
 * report regenerates with the same wind/heading numbers.
 */
let lastPushKey = '';

function buildSnapshotKey(s: WatchWeatherSnapshot): string {
    return [s.windKts, s.windDirDeg, s.gustKts ?? '', s.headingDeg ?? '', s.sogKts ?? '', s.pressureHpa ?? ''].join(
        '|',
    );
}

function wireWeatherPush(): void {
    // Subscribe to weatherData changes. The selector limits firing to
    // when the report itself changes (vs. loading flag flips etc.).
    weatherUnsub = useWeatherStore.subscribe(
        (s) => s.weatherData,
        async (weather) => {
            if (!weather) return;

            // Pull live SOG/COG from ShipLogService — the cockpit glance
            // wants the wrist to show the boat's current motion, not
            // just the static weather forecast. ShipLogService keeps
            // these fresh via its onLocation stream.
            let sogKts: number | undefined;
            let cogDeg: number | undefined;
            try {
                const { ShipLogService } = await import('../ShipLogService');
                const nav = ShipLogService.getGpsNavData();
                sogKts = nav.sogKts ?? undefined;
                cogDeg = nav.cogDeg ?? undefined;
            } catch {
                /* ShipLogService unavailable on web — that's fine, sog/cog stay undefined */
            }

            const cur = weather.current;
            const windKts = cur.windSpeed;
            const windDeg = cur.windDegree;
            // Bail early if we don't have minimally-useful wind data —
            // pushing zeros to the watch would just confuse the user.
            if (windKts === null || windKts === undefined || windDeg === null || windDeg === undefined) return;

            const snapshot: WatchWeatherSnapshot = {
                windKts,
                windDirDeg: windDeg,
                gustKts: cur.windGust ?? undefined,
                headingDeg: cogDeg,
                sogKts: sogKts,
                pressureHpa: cur.pressure ?? undefined,
                generatedAt: Date.now(),
            };

            const key = buildSnapshotKey(snapshot);
            if (key === lastPushKey) return;
            lastPushKey = key;

            try {
                await pushWeatherSnapshot(snapshot);
            } catch (e) {
                log.info('pushWeatherSnapshot failed (no watch?)', e);
            }
        },
    );

    // weatherUnsub captured above; we don't expose it externally — the
    // listener is meant to be one-shot for the session lifetime. Tests
    // call _resetForTests() to release it for re-init.
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
    initialized = false;
    lastPushKey = '';
}
