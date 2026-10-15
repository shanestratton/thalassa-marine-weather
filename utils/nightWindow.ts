/**
 * nightWindow — when 'Auto with night' goes red (131-03).
 *
 * Night here is nautical dusk to nautical dawn at the location: the sun 12°
 * down, the horizon gone, and a lit screen costing the helm its night eyes.
 * The instants are celestial.ts's getLastLight / getFirstLight on the
 * location's own day, so a Brisbane phone looking at Marseille goes red at
 * Marseille's dusk.
 *
 * Each night runs from one day's last light to the next day's first light,
 * so the hour is checked against yesterday's dusk as well as today's: in a
 * high summer the dusk can fall after midnight on the clock, and today's
 * dawn alone would call that last half-hour of twilight night.
 *
 * HYSTERESIS. Within NIGHT_HYSTERESIS_MS of a dusk or dawn the previous answer
 * stands, so a position that wanders a few seconds of dusk either way (a new
 * fix, a forecast refresh) cannot flick the screen red and back. With no
 * previous answer (the first look) the sky decides.
 *
 * THE POLES. Where the sun never sinks 12° there is no night to go red for:
 * the state says 'no-true-night' and Settings says so. Where it never climbs
 * that high ('stays-dark', the polar winter) it is night all day.
 */
import { getFirstLight, getLastLight, localNoon, type LightState, type LightTime } from './celestial';

const DAY_MS = 86_400_000;
/** How far past a dusk or dawn it must be before the answer changes. */
export const NIGHT_HYSTERESIS_MS = 5 * 60_000;

export interface NightWindow {
    /** Between nautical dusk and nautical dawn: show Night. */
    night: boolean;
    /** Today's twilight at the location: 'no-true-night' in a polar summer, 'stays-dark' in a polar winter. */
    state: LightState;
}

export function nightWindow(
    nowMs: number,
    lat: number,
    lon: number,
    tz?: string,
    wasNight: boolean | null = null,
): NightWindow {
    const noon = localNoon(new Date(nowMs), tz).getTime();
    const dusk = (ms: number) => getLastLight(new Date(ms), lat, lon, tz, 'nautical');
    const dawn = (ms: number) => getFirstLight(new Date(ms), lat, lon, tz, 'nautical');
    const today = dusk(noon);
    if (today.state === 'stays-dark') return { night: true, state: 'stays-dark' };
    // Last night (yesterday's dusk to this morning) and tonight (to tomorrow's
    // dawn). A day without the event on either end has no such night.
    const nights: [LightTime, LightTime][] = [
        [dusk(noon - DAY_MS), dawn(noon)],
        [today, dawn(noon + DAY_MS)],
    ];
    let night = false;
    let nearEdge = false;
    for (const [from, to] of nights) {
        if (!from.at || !to.at) continue;
        const a = from.at.getTime();
        const b = to.at.getTime();
        if (nowMs >= a && nowMs < b) night = true;
        if (Math.abs(nowMs - a) < NIGHT_HYSTERESIS_MS || Math.abs(nowMs - b) < NIGHT_HYSTERESIS_MS) nearEdge = true;
    }
    return { night: nearEdge && wasNight !== null ? wasNight : night, state: today.state };
}
