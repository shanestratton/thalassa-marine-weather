/**
 * soundingReadings — one hour of the sounding in plain words (build 125, SND).
 *
 * Each reading carries its number, in the skipper's units, and one headline
 * sentence leads and says what the layers mean (the readings stay short, so
 * the sheet fits a 320 × 568 screen with the diagram still readable). Seven
 * levels are coarse, so heights are rounded (cloud base and freezing level to
 * 50 m / 100 ft) and nothing claims more than they allow. Global wording:
 * "trade lid" only in the tropics, "dry lid" elsewhere, and nothing that
 * assumes a coast.
 *
 * The headline reads the whole column, not just CAPE: freezing air under a
 * warm nose first (ice on deck), then instability, then a column moist
 * through 850–500 hPa (layered cloud and rain, not showers), then the low
 * lid, and "settled" only when the 500 hPa height is not falling.
 *
 * Times are the location's own clock through its IANA zone, so a clock change
 * inside the 72 h shows on every later chip (Europe 25 Oct, the US 1 Nov).
 */
import type { LengthUnit, SpeedUnit, TempUnit } from '../../../types/units';
import type { SoundingData } from './soundingData';
import {
    cloudBaseRawMetres,
    dryLid,
    fillMissingHeights,
    freezingLevelMetres,
    fromKmh,
    magnusDewpoint,
    strongestInversion,
    surfacePressureHpa,
    toKnots,
    warmNose,
    type SoundingLevel,
} from './soundingMath';

export interface SoundingUnits {
    speed?: SpeedUnit;
    temp?: TempUnit;
    length?: LengthUnit;
}

export type SoundingReadingKey = 'cloudBase' | 'freezing' | 'instability' | 'inversion' | 'jet' | 'z500';

export interface SoundingReading {
    key: SoundingReadingKey;
    label: string;
    value: string;
}

export interface SoundingReport {
    /** The surface first, then every level above it with a temperature. */
    profile: SoundingLevel[];
    cape: number | null;
    /** Cloud base above the surface, m (unrounded). */
    cloudBaseM: number;
    /** "cloud base ≈ 600 ft", "cloud base: surface": the diagram's label on the LCL line, short enough for a 320 px plot. */
    cloudBaseLabel: string;
    headline: string;
    readings: SoundingReading[];
}

const FT = 3.28084;
const HOUR_MS = 3_600_000;
/** The trades blow roughly within 30° of the equator; poleward a dry stable layer is just a lid. */
const TRADE_LATITUDE = 30;

/** The profile at one hour, or null when the surface or most levels are missing. */
export function profileAt(data: SoundingData, i: number): SoundingLevel[] | null {
    const s = data.surface;
    const t0 = s.t[i];
    const td0 = s.td[i];
    const mslp = s.mslp[i];
    if (t0 == null || td0 == null || mslp == null) return null;
    const p0 = surfacePressureHpa(mslp, data.elevation, t0);
    const profile: SoundingLevel[] = [
        { p: p0, t: t0, td: td0, z: data.elevation, windKmh: s.windKmh[i], windFrom: s.windFrom[i] },
    ];
    for (const l of data.levels) {
        const t = l.t[i];
        const rh = l.rh[i];
        // Levels under the surface are the model's extrapolation, not air.
        if (l.p >= p0 || t == null || rh == null) continue;
        profile.push({
            p: l.p,
            t,
            td: magnusDewpoint(t, rh),
            z: l.z[i],
            windKmh: l.windKmh[i],
            windFrom: l.windFrom[i],
        });
    }
    // A partial sync can leave a height out: the hypsometric equation puts it back.
    return profile.length >= 4 ? fillMissingHeights(profile) : null;
}

const group = (n: number) => Math.round(n).toLocaleString('en-US');

function roundedHeight(m: number, unit: LengthUnit): string {
    return unit === 'ft' ? `${group(Math.round((m * FT) / 100) * 100)} ft` : `${group(Math.round(m / 50) * 50)} m`;
}

function exactHeight(m: number, unit: LengthUnit): string {
    return unit === 'ft' ? `${group(m * FT)} ft` : `${group(m)} m`;
}

function layerTop(m: number, unit: LengthUnit): string {
    return unit === 'ft' ? `${group(Math.round((m * FT) / 100) * 100)} ft` : `${(m / 1000).toFixed(1)} km`;
}

function layer(baseM: number, topM: number, unit: LengthUnit): string {
    if (unit === 'ft')
        return `${group(Math.round((baseM * FT) / 100) * 100)}–${group(Math.round((topM * FT) / 100) * 100)} ft`;
    return `${(baseM / 1000).toFixed(1)}–${(topM / 1000).toFixed(1)} km`;
}

export const SPEED_LABEL: Record<SpeedUnit, string> = { kts: 'kt', kmh: 'km/h', mps: 'm/s', mph: 'mph' };

function speed(kmh: number, unit: SpeedUnit): string {
    return `${Math.round(fromKmh(kmh, unit))} ${SPEED_LABEL[unit]}`;
}

function instability(cape: number | null): string {
    if (cape == null) return 'CAPE not in this run';
    const j = Math.round(cape);
    if (cape < 100) return `Stable (${j} J/kg)`;
    if (cape < 500) return `A little unstable (${j} J/kg)`;
    if (cape < 1500) return `Unstable (${j} J/kg)`;
    return `Very unstable (${j} J/kg)`;
}

/** The 500 hPa height at hour i and its change over the next 24 h (or, near the end of the run, the last 24 h). */
function z500Change(data: SoundingData, i: number): { now: number; dh: number | null; ahead: boolean } | null {
    const z = data.levels.find((l) => l.p === 500)?.z;
    const now = z?.[i];
    if (!z || now == null) return null;
    const ahead = z[i + 24];
    if (ahead != null) return { now, dh: ahead - now, ahead: true };
    const behind = z[i - 24];
    return { now, dh: behind != null ? now - behind : null, ahead: false };
}

function heightTrend(data: SoundingData, i: number, unit: LengthUnit): string {
    const change = z500Change(data, i);
    if (!change) return '—';
    const { now, dh } = change;
    if (dh == null) return exactHeight(now, unit);
    const amount = exactHeight(Math.abs(dh), unit);
    if (change.ahead) {
        if (Math.abs(dh) <= 15) return `${exactHeight(now, unit)}, steady over 24 h`;
        const note = dh < -30 ? ' (trough coming)' : dh > 30 ? ' (ridge building)' : '';
        return `${exactHeight(now, unit)}, ${dh > 0 ? 'rising' : 'falling'} ${amount} in 24 h${note}`;
    }
    if (Math.abs(dh) <= 15) return `${exactHeight(now, unit)}, steady over the past 24 h`;
    return `${exactHeight(now, unit)}, ${dh > 0 ? 'rose' : 'fell'} ${amount} over the past 24 h`;
}

/** Levels among 850, 700 and 500 hPa within 2 °C of saturation. */
function moistLevels(profile: SoundingLevel[]): number {
    return profile.filter((q) => [850, 700, 500].includes(q.p) && q.t - q.td <= 2).length;
}

/** The hour's readings and headline in the skipper's units, or null when there is too little to read. */
export function describeSounding(data: SoundingData, i: number, units: SoundingUnits): SoundingReport | null {
    const profile = profileAt(data, i);
    if (!profile) return null;
    const speedUnit = units.speed ?? 'kts';
    const tempUnit = units.temp ?? 'C';
    const length = units.length ?? 'm';
    const s = profile[0];
    const cloudM = cloudBaseRawMetres(s.t, s.td);
    const freezing = freezingLevelMetres(profile);
    const inversion = strongestInversion(profile);
    const lid = dryLid(profile);
    const lidName = Math.abs(data.lat) <= TRADE_LATITUDE ? 'trade lid' : 'dry lid';
    const cape = data.surface.cape[i];

    const cloudHeight = `≈ ${roundedHeight(cloudM, length)}`;
    const cloudText = cloudM < 25 ? 'Near the surface' : cloudHeight;
    let inversionText = 'None below 700 hPa';
    if (inversion) {
        const warming = tempUnit === 'F' ? inversion.warmingC * 1.8 : inversion.warmingC;
        inversionText = `${warming.toFixed(1)} °${tempUnit} warmer at ${inversion.topHpa} hPa`;
    } else if (lid) {
        inversionText = `${lidName[0].toUpperCase()}${lidName.slice(1)} ${layer(lid.baseM, lid.topM, length)}`;
    }

    const jetLevel = data.levels.find((l) => l.p === 250);
    const jetKmh = jetLevel?.windKmh[i];
    const jetFrom = jetLevel?.windFrom[i];
    let jet = '—';
    if (jetKmh != null && jetFrom != null) {
        // Under 50 kt there is no jet to speak of: just its speed, no bearing to follow.
        jet =
            toKnots(jetKmh, 'kmh') >= 50
                ? `${speed(jetKmh, speedUnit)} from ${Math.round(jetFrom)}°`
                : `None (${speed(jetKmh, speedUnit)})`;
    }

    const change = z500Change(data, i);
    const falling = change?.dh != null && change.dh < -30;
    const nose = warmNose(profile);
    let tail = '';
    if (nose && (moistLevels(profile) > 0 || s.t - s.td <= 2))
        tail = 'Freezing air under a warmer layer: rain can freeze on deck.';
    else if (cape != null && cape >= 1500) tail = 'Very unstable: showers and storms can build.';
    else if (cape != null && cape >= 500) tail = 'Unstable: showers can build.';
    else if (moistLevels(profile) >= 2) tail = 'Moist through the column: layered cloud and rain likely, not showers.';
    else if (inversion) tail = 'A low inversion caps the air: any cloud stays flat and low.';
    else if (lid)
        tail = `Tops capped near ${layerTop(lid.topM, length)} by the ${lidName}: flat cumulus, showers unlikely.`;
    else if (cape != null && cape >= 100) tail = 'A little unstable: a passing shower is possible.';
    else if (falling) tail = 'Stable now, but heights are falling: a trough is coming.';
    else if (cape != null) tail = 'Settled air, little to build cloud.';
    const lead = cloudM < 25 ? 'Cloud base near the surface.' : `Cloud base about ${roundedHeight(cloudM, length)}.`;
    const top = profile[profile.length - 1];

    return {
        profile,
        cape,
        cloudBaseM: cloudM,
        cloudBaseLabel: cloudM < 25 ? 'cloud base: surface' : `cloud base ${cloudHeight}`,
        headline: tail ? `${lead} ${tail}` : lead,
        readings: [
            { key: 'cloudBase', label: 'Cloud base', value: cloudText },
            {
                key: 'freezing',
                label: 'Freezing level',
                value:
                    s.t <= 0
                        ? 'At the surface'
                        : freezing == null
                          ? `Above ${Math.round(top.p)} hPa`
                          : roundedHeight(freezing, length),
            },
            { key: 'instability', label: 'Instability', value: instability(cape) },
            { key: 'inversion', label: 'Inversion', value: inversionText },
            { key: 'jet', label: 'Jet, 250 hPa', value: jet },
            { key: 'z500', label: '500 hPa height', value: heightTrend(data, i, length) },
        ],
    };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** One formatter per zone; null for a zone this engine does not know. */
const zoneClocks = new Map<string, Intl.DateTimeFormat | null>();

function zoneClock(timezone: string | null): Intl.DateTimeFormat | null {
    if (!timezone) return null;
    if (!zoneClocks.has(timezone)) {
        let clock: Intl.DateTimeFormat | null = null;
        try {
            clock = new Intl.DateTimeFormat('en-US', {
                timeZone: timezone,
                hourCycle: 'h23',
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
            });
        } catch {
            clock = null;
        }
        zoneClocks.set(timezone, clock);
    }
    return zoneClocks.get(timezone) ?? null;
}

/**
 * The location's wall clock at ms (never the phone's), as a UTC-read Date,
 * and the offset in force then. Through the IANA zone when the answer named
 * one, so a clock change inside the 72 h moves every later hour with it; the
 * answer's single offset otherwise.
 */
function wallClock(data: SoundingData, ms: number): { at: Date; offsetSeconds: number } {
    const clock = zoneClock(data.timezone);
    if (clock) {
        const part: Record<string, number> = {};
        for (const p of clock.formatToParts(ms)) if (p.type !== 'literal') part[p.type] = Number(p.value);
        const wall = Date.UTC(part.year, part.month - 1, part.day, part.hour % 24, part.minute);
        if (Number.isFinite(wall)) {
            const minute = Math.floor(ms / 60_000) * 60_000;
            return { at: new Date(wall), offsetSeconds: Math.round((wall - minute) / 1000) };
        }
    }
    return { at: new Date(ms + data.utcOffsetSeconds * 1000), offsetSeconds: data.utcOffsetSeconds };
}

const clockText = (d: Date) =>
    `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;

/** "Fri 9 Oct, 15:00" in the location's own time. */
export function formatSoundingTime(data: SoundingData, i: number): string {
    const d = wallClock(data, data.times[i]).at;
    return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${clockText(d)}`;
}

/** The location's UTC offset at hour i, in seconds: it changes with the clocks. */
export function utcOffsetAt(data: SoundingData, i: number): number {
    return wallClock(data, data.times[i]).offsetSeconds;
}

/** "UTC−4", "UTC+5:30". */
export function formatUtcOffset(seconds: number): string {
    const sign = seconds < 0 ? '−' : '+';
    const minutes = Math.abs(Math.round(seconds / 60));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return seconds === 0 ? 'UTC' : `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

export interface HourChoice {
    index: number;
    label: string;
    /** False when that hour's profile is too thin to draw. */
    available: boolean;
}

/** Now, then every third hour of the location's clock to 72 h ahead; a new day is named on its first chip. */
export function hourChoices(data: SoundingData): HourChoice[] {
    const t0 = data.times[0];
    if (t0 == null) return [];
    const choices: HourChoice[] = [{ index: 0, label: 'Now', available: profileAt(data, 0) != null }];
    let day = wallClock(data, t0).at.getUTCDate();
    for (let i = 1; i < data.times.length; i++) {
        if (data.times[i] - t0 > 72 * HOUR_MS) break;
        const d = wallClock(data, data.times[i]).at;
        // A half-hour zone (UTC+5:30) keeps its :30: the model's hours are UTC's.
        if (d.getUTCHours() % 3 !== 0) continue;
        const newDay = d.getUTCDate() !== day;
        day = d.getUTCDate();
        choices.push({
            index: i,
            label: newDay ? `${DAYS[d.getUTCDay()]} ${clockText(d)}` : clockText(d),
            available: profileAt(data, i) != null,
        });
    }
    return choices;
}
