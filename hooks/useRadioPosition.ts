import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { GpsService } from '../services/GpsService';
import { useSettingsStore } from '../stores/settingsStore';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';
import {
    RADIO_LOCAL_FIX_MAX_AGE_MS,
    createRadioBusReader,
    radioPhonePosition,
    radioPositionIsFresh,
    readRadioCloudPosition,
    readRadioPiPosition,
    validateRadioPosition,
    type RadioPositionFix,
} from '../services/radioPosition';

export type { RadioPositionFix } from '../services/radioPosition';
export const RADIO_POSITION_POLL_MS = 3_000;
export const RADIO_BOAT_READ_TIMEOUT_MS = 2_500;
export const RADIO_PHONE_READ_TIMEOUT_MS = 8_000;

export interface RadioPositionState {
    position: RadioPositionFix | null;
    ageMs: number | null;
    isLive: boolean;
    isFresh: boolean;
    acquiring: boolean;
    refreshing: boolean;
    /** The latest acquisition failed; a retained fix is history even if it is still young. */
    error: boolean;
    refresh: () => Promise<void>;
    requestGpsAccess: () => Promise<void>;
}

interface Snapshot {
    scope: AuthIdentityScope;
    vesselId: string | null;
    position: RadioPositionFix | null;
    refreshing: boolean;
    completed: boolean;
    error: boolean;
}

const subscribeIdentity = (notify: () => void) => subscribeAuthIdentityScope(() => notify());
const emptySnapshot = (scope: AuthIdentityScope, vesselId: string | null): Snapshot => ({
    scope,
    vesselId,
    position: null,
    refreshing: true,
    completed: false,
    error: false,
});

/**
 * One foreground acquisition at a time. A missed response never erases a good
 * coordinate or promotes the phone to a vessel position after the boat goes quiet.
 */
export function useRadioPosition(): RadioPositionState {
    const scope = useSyncExternalStore(subscribeIdentity, getAuthIdentityScope, getAuthIdentityScope);
    const vesselId = useSettingsStore((state) => state.activeVesselId);
    const [snapshot, setSnapshot] = useState<Snapshot>(() => emptySnapshot(scope, vesselId));
    const [now, setNow] = useState(Date.now);
    const runRef = useRef<((explicit: boolean) => Promise<void>) | null>(null);

    useEffect(() => {
        let active = true;
        let lastPosition: RadioPositionFix | null = null;
        let lastError = false;
        let inFlight: Promise<void> | null = null;
        let queuedExplicit: Promise<void> | null = null;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const controllers = new Set<AbortController>();
        const deadlines = new Map<ReturnType<typeof setTimeout>, () => void>();
        // A timed-out platform read may still be pending. Do not accumulate
        // more native/network requests for that lane while it finishes.
        const laneFlights = new Map<string, Promise<RadioPositionFix | null>>();
        const current = () =>
            active && isAuthIdentityScopeCurrent(scope) && useSettingsStore.getState().activeVesselId === vesselId;
        const busReader = createRadioBusReader();

        const boundedRead = async (
            lane: string,
            provider: (signal: AbortSignal) => Promise<RadioPositionFix | null>,
            timeoutMs: number,
        ): Promise<RadioPositionFix | null> => {
            if (!current() || laneFlights.has(lane)) return null;
            const controller = new AbortController();
            controllers.add(controller);
            const request = Promise.resolve()
                .then(() => (current() ? provider(controller.signal) : null))
                .catch(() => null);
            laneFlights.set(lane, request);
            void request.finally(() => {
                if (laneFlights.get(lane) === request) laneFlights.delete(lane);
                controllers.delete(controller);
            });
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                return await Promise.race([
                    request,
                    new Promise<null>((resolve) => {
                        const finish = () => {
                            controller.abort();
                            resolve(null);
                        };
                        timer = setTimeout(finish, timeoutMs);
                        deadlines.set(timer, finish);
                    }),
                ]);
            } finally {
                if (timer !== undefined) {
                    clearTimeout(timer);
                    deadlines.delete(timer);
                }
            }
        };

        const acquire = async (explicit: boolean): Promise<RadioPositionFix | null> => {
            const usable = (fix: RadioPositionFix | null) => {
                const valid = validateRadioPosition(fix);
                if (valid?.source === 'cloud' && (!vesselId || valid.vesselId !== vesselId)) return null;
                return valid && radioPositionIsFresh(valid) ? valid : null;
            };
            const bus = usable(busReader.read());
            if (bus) return bus;
            const pi = usable(await boundedRead('pi', readRadioPiPosition, RADIO_BOAT_READ_TIMEOUT_MS));
            if (!current()) return null;
            if (pi) return pi;
            const cloud = usable(
                await boundedRead(
                    'cloud',
                    (signal) => readRadioCloudPosition(signal, vesselId),
                    RADIO_BOAT_READ_TIMEOUT_MS,
                ),
            );
            if (!current()) return null;
            if (cloud) return cloud;
            // Once the vessel has answered, hold her last coordinates while
            // retrying. A phone carried ashore must never silently replace her.
            if (lastPosition?.isVessel) return null;
            return usable(
                await boundedRead(
                    'phone',
                    async () =>
                        radioPhonePosition(
                            await (explicit
                                ? GpsService.requestCurrentForegroundPosition({
                                      staleLimitMs: RADIO_LOCAL_FIX_MAX_AGE_MS,
                                      timeoutSec: RADIO_PHONE_READ_TIMEOUT_MS / 1_000,
                                  })
                                : GpsService.getCurrentPositionIfGranted({
                                      staleLimitMs: RADIO_LOCAL_FIX_MAX_AGE_MS,
                                      timeoutSec: RADIO_PHONE_READ_TIMEOUT_MS / 1_000,
                                  })),
                        ),
                    RADIO_PHONE_READ_TIMEOUT_MS,
                ),
            );
        };

        const run = (explicit: boolean): Promise<void> => {
            if (!current()) return Promise.resolve();
            if (inFlight) {
                if (!explicit) return inFlight;
                if (!queuedExplicit) {
                    queuedExplicit = inFlight.then(() => {
                        queuedExplicit = null;
                        return current() ? run(true) : undefined;
                    });
                }
                return queuedExplicit;
            }
            clearTimeout(pollTimer);
            setSnapshot((previous) => ({ ...previous, scope, vesselId, refreshing: true }));
            const task = acquire(explicit)
                .then((candidate) => {
                    if (!current()) return;
                    const fix = validateRadioPosition(candidate);
                    if (
                        fix &&
                        (!lastPosition ||
                            (fix.isVessel && !lastPosition.isVessel) ||
                            (fix.timestamp === lastPosition.timestamp &&
                                fix.receiverKey !== lastPosition.receiverKey) ||
                            fix.timestamp > lastPosition.timestamp)
                    ) {
                        lastPosition = fix;
                        lastError = false;
                    } else if (!fix || (lastPosition && fix.timestamp < lastPosition.timestamp)) {
                        lastError = true;
                    }
                    // A duplicate from the same receiver never clears a failed
                    // acquisition or renews its timestamp. A receiver change is
                    // accepted at equal time so old confirmation cannot follow it.
                    setSnapshot({
                        scope,
                        vesselId,
                        position: lastPosition,
                        refreshing: false,
                        completed: true,
                        error: lastError,
                    });
                    setNow(Date.now());
                })
                .catch(() => {
                    if (!current()) return;
                    lastError = true;
                    setSnapshot({
                        scope,
                        vesselId,
                        position: lastPosition,
                        refreshing: false,
                        completed: true,
                        error: true,
                    });
                })
                .finally(() => {
                    if (inFlight === task) inFlight = null;
                    if (current()) pollTimer = setTimeout(() => void run(false), RADIO_POSITION_POLL_MS);
                });
            inFlight = task;
            return task;
        };

        setSnapshot(emptySnapshot(scope, vesselId));
        setNow(Date.now());
        runRef.current = run;
        void run(false);
        const ageTimer = setInterval(() => {
            if (current()) setNow(Date.now());
        }, 1_000);
        return () => {
            active = false;
            if (runRef.current === run) runRef.current = null;
            clearInterval(ageTimer);
            clearTimeout(pollTimer);
            busReader.dispose();
            for (const controller of controllers) controller.abort();
            for (const [timer, finish] of deadlines) {
                clearTimeout(timer);
                finish();
            }
            deadlines.clear();
        };
    }, [scope, vesselId]);

    const refresh = useCallback(() => runRef.current?.(false) ?? Promise.resolve(), []);
    const requestGpsAccess = useCallback(() => runRef.current?.(true) ?? Promise.resolve(), []);
    // Hide the previous account synchronously, before effect cleanup runs.
    const visible =
        snapshot.scope === scope && snapshot.vesselId === vesselId ? snapshot : emptySnapshot(scope, vesselId);
    const position = visible.position;
    const ageMs = position ? Math.max(0, now - position.timestamp) : null;
    const isFresh = !!position && !visible.error && radioPositionIsFresh(position, now);
    return {
        position,
        ageMs,
        isFresh,
        isLive: isFresh && position?.source !== 'cloud',
        acquiring: !position && !visible.completed,
        refreshing: visible.refreshing,
        error: visible.error,
        refresh,
        requestGpsAccess,
    };
}
