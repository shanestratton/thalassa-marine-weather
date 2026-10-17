import { getMoonTimes, getMoonTransits, localNoon, wallClock } from './celestial';

/** Traditional two-hour major and one-hour minor windows, not an assertion
 * about animal behaviour. Crossings are calculated independently for the
 * actual local day; a missing crossing is never filled by adding 12 hours. */
export function solunarPeriods(isoDate: string, lat: number, lon: number, timeZone?: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
    const noon = localNoon(isoDate, timeZone),
        transits = getMoonTransits(noon, lat, lon, timeZone);
    if (transits.state === 'unavailable') return null;
    const moon = getMoonTimes(noon, lat, lon, timeZone);
    const date = wallClock(noon.getTime(), timeZone);
    if (
        date
            .slice(0, 3)
            .map((part, index) => String(part).padStart(index ? 2 : 4, '0'))
            .join('-') !== isoDate
    )
        return null;
    const base = Date.UTC(date[0], date[1] - 1, date[2]);
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const format = (ms: number) => {
        const day = wallClock(ms, timeZone),
            offset = Math.round((Date.UTC(day[0], day[1] - 1, day[2]) - base) / 86400000);
        return clock.format(ms) + (offset < 0 ? ' (previous day)' : offset > 0 ? ' (next day)' : '');
    };
    const window = (at: Date, halfMinutes: number) =>
        `${format(at.getTime() - halfMinutes * 60000)}–${format(at.getTime() + halfMinutes * 60000)}`;
    return [
        { label: 'Major · upper transit', times: transits.upper.map((at) => window(at, 60)) },
        { label: 'Major · lower transit', times: transits.lower.map((at) => window(at, 60)) },
        { label: 'Minor · moonrise', times: moon.rise ? [window(moon.rise, 30)] : [] },
        { label: 'Minor · moonset', times: moon.set ? [window(moon.set, 30)] : [] },
    ];
}
