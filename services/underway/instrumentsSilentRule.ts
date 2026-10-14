/**
 * The aboard GPS/instruments-silent alarm (129-08), as a pure rule: what was
 * Calypso's 'nmea-backbone-dead' rule, now a local alarm in the under-way
 * watch that needs neither Calypso nor the internet.
 *
 * "No GPS or instruments from the boat for N minutes", after 2 minutes with
 * nothing, when all of these hold:
 *  - the phone is aboard (services/boatLink: by position, or the Pi seeing
 *    this phone on its own network); it never fires otherwise;
 *  - the last live reading came from the boat herself, down the gateway
 *    socket or from the Pi over the boat's network: a cloud row that stops is
 *    the internet, not her instruments;
 *  - silence matters: under way (by her last live data, not only a speed
 *    read after it died), an anchor watch on, a voyage track recording, or a
 *    route followed. A berth with the instruments switched off says nothing.
 * Once sounding it keeps going (her own GPS is what tells "aboard", and it is
 * what went quiet) until the data is back, it is acknowledged (silent until
 * the data is back, then it re-arms), or the phone is shown to be ashore.
 */

export const INSTRUMENTS_SILENT_AFTER_MS = 2 * 60_000;

/** The lanes BoatLink names; only the first two are the boat herself. */
export type BoatLane = 'socket' | 'pi-direct' | 'cloud' | 'shared' | 'none';

export interface InstrumentsSilentInput {
    nowMs: number;
    where: 'aboard' | 'ashore' | 'unknown';
    /** The boat's data is live now, by any lane. */
    live: boolean;
    /** The last live reading this phone had from the boat, and its lane. */
    lastLive: { at: number; lane: BoatLane } | null;
    /** Under way (now, or while her data was last live), an anchor watch on, a track recording or a route followed. */
    armed: boolean;
}

export interface InstrumentsSilentState {
    status: 'quiet' | 'sounding' | 'acknowledged';
    /** The last reading's time, while sounding or acknowledged. */
    since: number | null;
}

export const INSTRUMENTS_SILENT_START: InstrumentsSilentState = Object.freeze({ status: 'quiet', since: null });

export function nextInstrumentsSilent(
    state: InstrumentsSilentState,
    input: InstrumentsSilentInput,
): InstrumentsSilentState {
    if (input.live || input.where === 'ashore') return INSTRUMENTS_SILENT_START;
    if (state.status !== 'quiet') return state;
    const last = input.lastLive;
    if (!last || (last.lane !== 'socket' && last.lane !== 'pi-direct')) return INSTRUMENTS_SILENT_START;
    if (input.where !== 'aboard' || !input.armed || input.nowMs - last.at < INSTRUMENTS_SILENT_AFTER_MS) {
        return INSTRUMENTS_SILENT_START;
    }
    return { status: 'sounding', since: last.at };
}

export function acknowledgeInstrumentsSilent(state: InstrumentsSilentState): InstrumentsSilentState {
    return state.status === 'sounding' ? { ...state, status: 'acknowledged' } : state;
}

function forMinutes(state: InstrumentsSilentState, nowMs: number): string {
    const minutes = Math.max(1, Math.floor((nowMs - (state.since ?? nowMs)) / 60_000));
    return `No GPS or instruments from the boat for ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

const CHECK = 'check her instruments’ power and the gateway';

/** The card's lines (the under-way cards' AlarmLines shape). */
export function instrumentsSilentLines(
    state: InstrumentsSilentState,
    nowMs: number,
): { title: string; value: string; detail: string } {
    return { title: 'INSTRUMENTS SILENT', value: forMinutes(state, nowMs), detail: CHECK };
}

export function instrumentsSilentLockScreen(
    state: InstrumentsSilentState,
    nowMs: number,
): { title: string; body: string } {
    return { title: forMinutes(state, nowMs), body: 'Check her instruments’ power and the gateway.' };
}
