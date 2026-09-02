/**
 * useBarometerSource — pressure history from the best barometer aboard.
 *
 * Two sensors can answer, and they are not equals:
 *
 *   BOAT (BMP390 on the Pi) wins whenever it is reachable. It is bolted to
 *   the vessel and mains-powered, so it neither moves nor sleeps — and both
 *   of those matter more than they sound. Altitude reads as pressure at
 *   roughly 0.12 hPa per metre, so a phone carried up the companionway or up
 *   the dock ramp invents pressure changes several times larger than the
 *   1-2 hPa/3h that actually forecasts weather. The Pi also keeps twelve
 *   hours across restarts, so the three-hour tendency is real history rather
 *   than "since the app opened".
 *
 *   PHONE (CMAltimeter) is the fallback for a skipper away from the boat, or
 *   any boat without a Pi. Perfectly good for a spot reading; its trend is
 *   only as trustworthy as the phone has been still.
 *
 * The hook never throws and never blocks the panel: it starts with whatever
 * the phone already has, upgrades to the boat when the Pi answers, and says
 * plainly which one is talking so the UI can too.
 */
import { useEffect, useState } from 'react';
import * as barometer from '../services/native/barometer';
import { piCache } from '../services/PiCacheService';
import type { PressureSample } from '../utils/barometerTendency';
import { createLogger } from '../utils/createLogger';

const log = createLogger('baroSource');

/** The Pi samples once a minute; asking faster only burns battery. */
const BOAT_POLL_MS = 60_000;
/** Older than this and the boat sensor is not "live" any more — fall back. */
const BOAT_STALE_MS = 10 * 60_000;

export type BarometerSourceKind = 'boat' | 'phone' | 'none';

export interface BarometerSourceState {
    /** Chronological, oldest first — what the tendency maths expects. */
    samples: PressureSample[];
    latest: PressureSample | null;
    source: BarometerSourceKind;
    /** Why there is nothing, or nothing better — shown, never swallowed. */
    reason: string | null;
}

const EMPTY: BarometerSourceState = { samples: [], latest: null, source: 'none', reason: null };

export function useBarometerSource(active: boolean): BarometerSourceState {
    const [state, setState] = useState<BarometerSourceState>(EMPTY);

    useEffect(() => {
        if (!active) return;
        let cancelled = false;

        /** The phone's own record — always computed, so a boat dropout has somewhere to land. */
        const phoneState = (): BarometerSourceState => {
            const samples = barometer.getSeaLevelSamples();
            const latest = samples.length > 0 ? samples[samples.length - 1] : null;
            /* PressureSample.t is epoch ms — same clock as the boat's `at`. */
            return {
                samples,
                latest,
                source: latest ? 'phone' : 'none',
                reason: latest ? null : 'No barometer on this device yet',
            };
        };

        const poll = async (): Promise<void> => {
            let next = phoneState();
            try {
                const boat = await piCache.getBarometer();
                if (cancelled) return;
                if (boat?.available && boat.latest) {
                    const age = Date.now() - boat.latest.at;
                    if (age <= BOAT_STALE_MS) {
                        // The Pi's own shape → the tendency library's shape.
                        const samples: PressureSample[] = boat.samples
                            .filter((s) => Number.isFinite(s.hpa) && Number.isFinite(s.at))
                            .map((s) => ({ hpa: s.hpa, t: s.at }));
                        if (samples.length > 0) {
                            next = {
                                samples,
                                latest: samples[samples.length - 1],
                                source: 'boat',
                                reason: null,
                            };
                        }
                    } else {
                        next = { ...next, reason: 'Boat barometer has gone quiet — using this device' };
                    }
                } else if (boat && !boat.available && boat.reason) {
                    // A Pi that is present but has no sensor fitted is worth
                    // saying once; it is a wiring answer, not a failure.
                    log.debug(`boat barometer unavailable: ${boat.reason}`);
                }
            } catch {
                /* Pi lane unusable — the phone state already stands */
            }
            if (!cancelled) setState(next);
        };

        // Paint immediately from the phone so the panel is never blank while
        // the Pi is being asked.
        setState(phoneState());
        void poll();
        const timer = setInterval(() => void poll(), BOAT_POLL_MS);
        // The phone logger pushes its own updates; mirror them between polls
        // so a phone-sourced panel is not frozen for a minute at a time.
        const unsubscribe = barometer.subscribe(() => {
            if (cancelled) return;
            setState((current) => (current.source === 'boat' ? current : phoneState()));
        });

        return () => {
            cancelled = true;
            clearInterval(timer);
            unsubscribe();
        };
    }, [active]);

    return state;
}
