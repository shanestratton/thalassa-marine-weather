/**
 * SunMoonSheet — the Glass header's "Sun and moon" chip, in full (build 123,
 * W1-09). For the day on screen, at the Glass point:
 *   - sunrise, sunset and the day's length;
 *   - civil, nautical and astronomical twilight (sun 6°, 12° and 18° down);
 *   - the moon's phase, its rise and set, its altitude (now, on today; its
 *     highest in that night's dark, on a later day);
 *   - how long the moon is up in tonight's dark (sun more than 6° down), or
 *     on today after dusk, in the night the boat is in.
 *
 * Everything is the location's own day on its own clock, whatever the phone's
 * zone, and worked out on the phone (utils/celestial, USNO-checked in
 * W1-06): it works offshore with no signal, and needs no data credit. Polar
 * days and nights say what happens ('Sun stays up', 'No true night') instead
 * of '--:--'. Centred, clear of the tab bar, scrolling inside itself when a
 * short phone needs it. Loaded only when opened.
 */
import React, { useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePanePortalTarget } from '../../context/PanePortalContext';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import {
    NO_TRUE_NIGHT,
    SUN_STAYS_DOWN,
    getFirstLight,
    getLastLight,
    getMoonData,
    getSolarTimes,
    localNoon,
    moonlightByNight,
    startOfLocalDay,
    sunAltitudeDeg,
    type LightTime,
    type TwilightKind,
} from '../../utils/celestial';
import { readableZoneName } from '../../utils/zoneLabel';

interface SunMoonSheetProps {
    onClose: () => void;
    lat: number;
    lon: number;
    /** The location's IANA zone; the phone's when unknown. */
    timeZone?: string;
    /** The day on screen, on the location's calendar (YYYY-MM-DD). */
    isoDate: string;
    /** Today: the moon's altitude is given for now. */
    isToday: boolean;
}

const HOUR_MS = 3_600_000;
const TWILIGHTS: [TwilightKind, string][] = [
    ['civil', 'Civil'],
    ['nautical', 'Nautical'],
    ['astronomical', 'Astronomical'],
];

function formatIn(timeZone: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    try {
        return new Intl.DateTimeFormat('en-GB', { ...options, timeZone });
    } catch {
        return new Intl.DateTimeFormat('en-GB', options);
    }
}

const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** A twilight's dawn or dusk: its time, or why there is none that day. */
const lightWords = (t: LightTime, clock: Intl.DateTimeFormat) =>
    t.at
        ? clock.format(t.at)
        : t.state === 'no-true-night'
          ? NO_TRUE_NIGHT
          : t.state === 'stays-dark'
            ? SUN_STAYS_DOWN
            : '--:--';

/** The location's local mean solar hour at `ms`, 0–24. */
const solarHour = (ms: number, lon: number) => (((ms / HOUR_MS + lon / 15) % 24) + 24) % 24;
/** The mean solar noon nearest `ms` (the clock's noon is up to ~3 h off it). */
const solarNoonNear = (ms: number, lon: number) => ms - (solarHour(ms, lon) - 12) * HOUR_MS;
/** The last mean solar noon at or before `ms`. */
const solarNoonBefore = (ms: number, lon: number) => ms - ((solarHour(ms, lon) + 12) % 24) * HOUR_MS;

export function sunMoonDay(
    lat: number,
    lon: number,
    isoDate: string,
    timeZone: string | undefined,
    nowMs: number,
    isToday: boolean,
) {
    const noon = localNoon(isoDate, timeZone);
    const clock = formatIn(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const solar = getSolarTimes(noon, lat, lon, timeZone);

    // Minutes with the sun's upper limb above the refracted horizon (−0.833°)
    // in the location's day, which is 23–25 h long on a clock-change day.
    const start = startOfLocalDay(noon, timeZone).getTime();
    const end = startOfLocalDay(new Date(start + 26 * HOUR_MS), timeZone).getTime();
    let up = 0;
    for (let t = start + 30_000; t < end; t += 60_000) if (sunAltitudeDeg(new Date(t), lat, lon) > -0.833) up++;
    const dayMinutes = Math.round((end - start) / 60_000);
    const dayLength =
        up === 0
            ? 'None, the sun never rises'
            : up >= dayMinutes
              ? '24 h, the sun never sets'
              : `${Math.floor(up / 60)} h ${up % 60} min`;

    const twilight = TWILIGHTS.map(([kind, label]) => ({
        kind,
        label,
        dawn: lightWords(getFirstLight(noon, lat, lon, timeZone, kind), clock),
        dusk: lightWords(getLastLight(noon, lat, lon, timeZone, kind), clock),
    }));

    const moon = getMoonData(isToday ? new Date(nowMs) : noon, lat, lon, timeZone);
    // The night: dark is the sun more than 6° down. moonlightByNight parts one
    // night from the next at MEAN SOLAR noon, so the window starts at one and
    // holds a single night, whole even in polar night (from the clock's noon,
    // where solar noon comes later, it held a stub: Dikson, 1.7 h of ~24).
    // Today, in the dark already (a night watch), it is the night the boat is
    // in; otherwise the one after this day's noon.
    const darkNow = isToday && sunAltitudeDeg(new Date(nowMs), lat, lon) < -6;
    const from = darkNow ? solarNoonBefore(nowMs, lon) : solarNoonNear(noon.getTime(), lon);
    const night = moonlightByNight(from, from + 24 * HOUR_MS, () => ({ lat, lon })).find((n) => n.darkHours >= 0.25);
    let altitude: string;
    if (isToday) {
        const deg = Math.round((moon.altitude * 180) / Math.PI);
        altitude = `Now ${Math.abs(deg)}° ${deg >= 0 ? 'above' : 'below'} the horizon`;
    } else {
        // Its highest point in that night's dark, or over the day if it has none.
        const [from, to] = night ? [night.startMs, night.endMs] : [start, end];
        let best = -Infinity;
        for (let t = from; t <= to; t += 15 * 60_000)
            best = Math.max(best, getMoonData(new Date(t), lat, lon).altitude);
        const deg = Math.round((best * 180) / Math.PI);
        altitude =
            deg < 0
                ? night
                    ? 'Below the horizon all through tonight’s dark'
                    : 'Below the horizon all day'
                : `${night ? 'Highest in tonight’s dark' : 'Highest that day'}: ${deg}°`;
    }

    return {
        dateLabel: formatIn(timeZone, { weekday: 'short', day: 'numeric', month: 'short' }).format(noon),
        sunrise: solar.sunrise,
        sunset: solar.sunset,
        dayLength,
        twilight,
        moonPhase: `${sentenceCase(moon.phaseName)}, ${Math.round(moon.illumination * 100)}% lit`,
        moonrise: moon.moonrise ?? 'None that day',
        moonset: moon.moonset ?? 'None that day',
        altitude,
        tonight: night
            ? `${darkNow ? 'This night: up' : 'Up'} ${night.moonUpHours.toFixed(1)} h of ${night.darkHours.toFixed(1)} h of darkness`
            : 'No darkness tonight',
        // An open-ocean 'Etc/GMT+3' is UTC-3: say the offset, not the POSIX-signed ID.
        zoneLabel: timeZone ? readableZoneName(timeZone, noon.getTime()) : 'this phone’s zone',
    };
}

const Stat: React.FC<{ label: string; value: string; testId: string }> = ({ label, value, testId }) => (
    <div className="min-w-0 rounded-xl bg-white/4 px-2 py-1.5 text-center">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{label}</div>
        <div data-testid={testId} className="text-sm font-bold text-white tabular-nums leading-tight">
            {value}
        </div>
    </div>
);

export const SunMoonSheet: React.FC<SunMoonSheetProps> = ({ onClose, lat, lon, timeZone, isoDate, isToday }) => {
    const portalTarget = usePanePortalTarget();
    const closeRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, { initialFocusRef: closeRef, onEscape: onClose });
    // Fixed per opening, so the figures do not shift while the sheet is read.
    const day = useMemo(
        () => sunMoonDay(lat, lon, isoDate, timeZone, Date.now(), isToday),
        [lat, lon, isoDate, timeZone, isToday],
    );
    const where = `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;

    return createPortal(
        <div
            className="fixed inset-0 z-9999 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
            onClick={onClose}
            role="presentation"
        >
            {/* Centred per the standing modal rule (Shane 2026-09-02). */}
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal={portalTarget?.tagName === 'BODY' ? true : undefined}
                aria-labelledby="sun-moon-title"
                className="w-full max-w-sm bg-slate-900/95 border border-white/8 rounded-3xl shadow-2xl max-h-full overflow-y-auto animate-in fade-in zoom-in-95 duration-300"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="h-[2px] bg-linear-to-r from-transparent via-amber-400/60 to-transparent" />
                <div className="flex items-start justify-between gap-2 px-5 pt-3 pb-2">
                    <div className="min-w-0">
                        <h2 id="sun-moon-title" className="text-sm font-black text-white uppercase tracking-wider">
                            Sun and moon
                        </h2>
                        <p className="text-[11px] text-gray-400 mt-0.5">
                            {day.dateLabel} · Times in {day.zoneLabel}
                        </p>
                    </div>
                    <button
                        ref={closeRef}
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="hit-target-44 shrink-0 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                    >
                        <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            aria-hidden="true"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                            />
                        </svg>
                    </button>
                </div>

                <div className="px-5 pb-1 grid grid-cols-2 gap-1.5">
                    <Stat label="Sunrise" value={day.sunrise} testId="sun-sunrise" />
                    <Stat label="Sunset" value={day.sunset} testId="sun-sunset" />
                </div>
                <p className="px-5 pb-2 text-[12px] text-gray-300">
                    Day length{' '}
                    <span data-testid="sun-daylength" className="font-semibold text-white">
                        {day.dayLength}
                    </span>
                </p>

                <div className="px-5 pb-2">
                    <table className="w-full text-[12px] tabular-nums">
                        <caption className="text-left text-[11px] font-semibold uppercase tracking-wider text-gray-400 pb-0.5">
                            Twilight
                        </caption>
                        <thead>
                            <tr className="text-[11px] text-gray-400">
                                <td />
                                <th scope="col" className="text-right font-semibold pb-0.5">
                                    Dawn
                                </th>
                                <th scope="col" className="text-right font-semibold pb-0.5">
                                    Dusk
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {day.twilight.map((row) => (
                                <tr key={row.kind} className="border-t border-white/5">
                                    <th scope="row" className="py-1 text-left font-semibold text-gray-300">
                                        {row.label}
                                    </th>
                                    <td
                                        data-testid={`twilight-${row.kind}-dawn`}
                                        className="py-1 text-right text-white"
                                    >
                                        {row.dawn}
                                    </td>
                                    <td
                                        data-testid={`twilight-${row.kind}-dusk`}
                                        className="py-1 text-right text-white"
                                    >
                                        {row.dusk}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div className="px-5 pb-2">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 pb-0.5">Moon</h3>
                    <p data-testid="moon-phase" className="text-[12px] text-white">
                        {day.moonPhase}
                    </p>
                    <div className="grid grid-cols-2 gap-1.5 py-1">
                        <Stat label="Moonrise" value={day.moonrise} testId="moon-rise" />
                        <Stat label="Moonset" value={day.moonset} testId="moon-set" />
                    </div>
                    <p data-testid="moon-altitude" className="text-[12px] text-gray-300">
                        {day.altitude}
                    </p>
                    <p data-testid="moon-tonight" className="text-[12px] text-gray-300">
                        {day.tonight}
                    </p>
                </div>

                <p className="px-5 pb-3 text-[10px] text-gray-400">
                    Worked out on this phone for {where}; darkness is the sun more than 6° down.
                </p>
            </div>
        </div>,
        portalTarget!,
    );
};

SunMoonSheet.displayName = 'SunMoonSheet';
