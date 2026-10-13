/**
 * Her motion, as the own-ship marker resolved it (127-11b).
 *
 * The chart's orientation must turn by the same rules her bow arrow does, so
 * it never reads a receiver of its own: useVesselTracker publishes what it
 * already chose (the lane, her fix, the lane's instruments and how old they
 * may be) and chartOrientation applies its per-mode rules with
 * ownshipDirection's freshness helpers. Same lanes, same gates, and never a
 * vessel compass borrowed for the phone's fix. Nothing new on the Capacitor
 * bridge: this is a plain module store.
 */
import type { DirectionInstruments } from './ownshipDirection';

export interface OwnshipMotion {
    lane: 'bus' | 'pi' | 'cloud' | 'held' | 'phone';
    lat: number;
    lon: number;
    /** Her fix's own time. */
    at: number;
    /** The phone's GPS course (its geolocation heading) and speed in m/s; her lanes read `instruments`. */
    heading: number | null;
    speed: number | null;
    /** Her lane's instruments: the bus's store, her Pi or cloud row's own; none for the phone or a held fix. */
    instruments: DirectionInstruments;
    /** How old the lane's readings may be. */
    maxAgeMs: number;
}

let motion: OwnshipMotion | null = null;
const listeners = new Set<() => void>();

/** Her motion now; null while no marker is drawn. */
export const ownshipMotion = (): OwnshipMotion | null => motion;

export function publishOwnshipMotion(next: OwnshipMotion | null): void {
    motion = next;
    for (const listener of [...listeners]) listener();
}

export function subscribeOwnshipMotion(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
