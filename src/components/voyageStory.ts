/**
 * Pure helpers that turn the public voyage payload into the words and numbers
 * the page tells its followers: the last-known flag, the instruments line,
 * the trip chip, waypoint labels and the passage facts.
 *
 * No React and no JSX here. Every surface that says the same thing (the map
 * flag and the header, the hero tiles and the diary chapter head) imports it
 * from this one module, so they can never disagree about wording or maths.
 */
import type {
    PublicVoyageTrip,
    VoyageLogInstruments,
    VoyageLogTelemetry,
    VoyageLogTrackPoint,
    VoyageLogWaypoint,
} from '../voyageLogApi';
import { formatPublicAge, isPublicPositionFresh } from '../publicVoyageFreshness';

/**
 * The newest usable sailed fix in the payload. Planned-route points, fixes
 * outside the globe, the 0/0 null island and unparsable timestamps never
 * count. Moved verbatim from MapContainer so the header and the map agree.
 */
export function latestPublicTrackPoint(track: VoyageLogTrackPoint[]): VoyageLogTrackPoint | undefined {
    let latest: VoyageLogTrackPoint | undefined;
    for (const point of track) {
        if (
            point.voyage_id?.startsWith('planned_') ||
            !Number.isFinite(point.lat) ||
            !Number.isFinite(point.lon) ||
            Math.abs(point.lat) > 90 ||
            Math.abs(point.lon) > 180 ||
            (point.lat === 0 && point.lon === 0) ||
            !Number.isFinite(Date.parse(point.timestamp))
        )
            continue;
        if (!latest || Date.parse(point.timestamp) >= Date.parse(latest.timestamp)) latest = point;
    }
    return latest;
}

/**
 * 'Last known · {age}' whenever the page shows a position that is not live,
 * or null when there is no fix at all or the fix is independently fresh.
 * Byte-for-byte the string MapContainer has always built for the boat flag.
 */
export function publicLastKnownLabel({
    latest,
    telemetry,
    connectionLost,
    nowMs,
}: {
    latest: VoyageLogTrackPoint | null | undefined;
    /** Only the position fields are read, so MapContainer's slim prop fits. */
    telemetry: Pick<VoyageLogTelemetry, 'lat' | 'lon' | 'updated_at' | 'is_last_known'> | null | undefined;
    connectionLost: boolean;
    nowMs: number;
}): string | null {
    const hasTelemetryFix = !!telemetry && Number.isFinite(telemetry.lat) && Number.isFinite(telemetry.lon);
    if (!latest && !hasTelemetryFix) return null;
    const positionIsLive =
        !connectionLost &&
        telemetry !== null &&
        telemetry !== undefined &&
        !telemetry.is_last_known &&
        isPublicPositionFresh(telemetry.updated_at, nowMs);
    if (positionIsLive) return null;
    return `Last known · ${formatPublicAge(telemetry?.updated_at ?? latest?.timestamp ?? null, nowMs)}`;
}

/**
 * The instruments row's freshness, or null when there is nothing to show.
 * "Something to show" is TelemetryPanel's `available` test: any finite
 * numeric field other than the three-hour pressure delta.
 */
export function instrumentHeadline(
    instruments: VoyageLogInstruments | null | undefined,
    nowMs: number,
): { live: boolean; age: string } | null {
    if (!instruments) return null;
    const available = Object.entries(instruments).some(
        ([key, value]) => key !== 'pressure_3h' && typeof value === 'number' && Number.isFinite(value),
    );
    if (!available) return null;
    return {
        live: isPublicPositionFresh(instruments.updated_at, nowMs),
        age: formatPublicAge(instruments.updated_at, nowMs),
    };
}

/** The chip face drops the 'Track · ' prefix; the <option> text keeps it. */
export function stripTrackPrefix(label: string): string {
    return label.replace(/^Track · /, '');
}

/**
 * Split a server waypoint name on its FIRST ' · ' so the qualifier can sit
 * as a quiet second line: 'Hamilton Island · recovered departure' becomes
 * place 'Hamilton Island', role 'recovered departure'. Names without a
 * qualifier ('Voyage Start') come back whole with role null.
 */
export function splitWaypointName(name: string): { place: string; role: string | null } {
    const at = name.indexOf(' · ');
    if (at < 0) return { place: name, role: null };
    const place = name.slice(0, at).trim();
    const role = name.slice(at + 3).trim();
    // Never render an empty place line: keep the whole name as the label.
    if (!place) return { place: name.trim(), role: null };
    return { place, role: role || null };
}

// ── Boat-local dates ────────────────────────────────────────────────
//
// The diary cards format in the viewer's own zone (Intl with no timeZone),
// so that is the fallback whenever the server has not said which zone a
// trip or waypoint sits in. Never UTC: the server's old picker labels were
// built in UTC, which put four of seven Whitsundays trips a day early.

/** The zone the diary already uses: the viewer's own (undefined for Intl). */
export const DIARY_TIME_ZONE: string | undefined = undefined;

const knownZones = new Map<string, string | undefined>();

/** A zone Intl accepts, or undefined (the viewer's own zone). */
export function usableTimeZone(zone: string | null | undefined): string | undefined {
    const name = typeof zone === 'string' ? zone.trim() : '';
    if (!name) return undefined;
    if (!knownZones.has(name)) {
        let accepted: string | undefined;
        try {
            new Intl.DateTimeFormat('en', { timeZone: name });
            accepted = name;
        } catch {
            accepted = undefined;
        }
        knownZones.set(name, accepted);
    }
    return knownZones.get(name);
}

type LocalFormat = 'day' | 'dayYear' | 'date' | 'dateYear' | 'year' | 'time' | 'stamp' | 'zone';
const LOCAL_FORMATS: Record<LocalFormat, Intl.DateTimeFormatOptions> = {
    day: { weekday: 'short', day: 'numeric', month: 'short' },
    dayYear: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' },
    date: { day: 'numeric', month: 'short' },
    dateYear: { day: 'numeric', month: 'short', year: 'numeric' },
    year: { year: 'numeric' },
    time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    // Wall-clock identity, for 'is this zone's time the viewer's time?'
    stamp: { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' },
    zone: { timeZoneName: 'short' },
};
const localFormatters = new Map<string, Intl.DateTimeFormat>();

function localFormatter(kind: LocalFormat, zone: string | undefined, locale: string | undefined): Intl.DateTimeFormat {
    const key = `${kind}|${zone ?? ''}|${locale ?? ''}`;
    let formatter = localFormatters.get(key);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, { ...LOCAL_FORMATS[kind], timeZone: zone });
        localFormatters.set(key, formatter);
    }
    return formatter;
}

/** The first zone in the list that Intl accepts, else the diary's zone. */
const pickZone = (...zones: (string | null | undefined)[]): string | undefined => {
    for (const zone of zones) {
        const usable = usableTimeZone(zone);
        if (usable) return usable;
    }
    return DIARY_TIME_ZONE;
};

export interface LocalDateOptions {
    /** Used when the item carries no usable zone. Defaults to the diary's. */
    fallbackZone?: string | null;
    /** 'Now', for the this-year test. Defaults to the clock. */
    nowMs?: number;
    /** Tests pin this; the page leaves it to the viewer, like the diary. */
    locale?: string;
    /** 'Sat 26 Sep' (the default) or, false, '26 Sep' for a stat tile. */
    weekday?: boolean;
    /** The reader's own zone; tests pin it, the page leaves it to the browser. */
    viewerTimeZone?: string;
}

/**
 * 'Sat 26 Sep' in the given zone, in the diary cards' style: the locale's
 * own order and words with list commas dropped, and the year only when it
 * is not this year. `weekday: false` gives '26 Sep'. Null for a missing or
 * unparsable timestamp.
 */
export function formatLocalDay(
    iso: string | null | undefined,
    zone: string | null | undefined,
    { fallbackZone, nowMs = Date.now(), locale, weekday = true }: LocalDateOptions = {},
): string | null {
    const at = iso ? Date.parse(iso) : Number.NaN;
    if (!Number.isFinite(at)) return null;
    const tz = pickZone(zone, fallbackZone);
    const year = localFormatter('year', tz, locale);
    const thisYear = year.format(at) === year.format(nowMs);
    const kind = weekday ? (thisYear ? 'day' : 'dayYear') : thisYear ? 'date' : 'dateYear';
    return localFormatter(kind, tz, locale)
        .formatToParts(at)
        .map((part) => (part.type === 'literal' ? part.value.replace(/[,،、，]/g, ' ') : part.value))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 'Sat 26 Sep · 08:42' in the given zone (the progress bar's ' · ' separator).
 * When that zone's clock differs from the reader's at that moment, the zone
 * is named ('08:42 AEST'), so a reader in Los Angeles never takes the boat's
 * time for their own.
 */
export function formatLocalMoment(
    iso: string | null | undefined,
    zone: string | null | undefined,
    options: LocalDateOptions = {},
): string | null {
    const day = formatLocalDay(iso, zone, { ...options, weekday: true });
    if (!day || !iso) return null;
    const at = Date.parse(iso);
    const tz = pickZone(zone, options.fallbackZone);
    const time = localFormatter('time', tz, options.locale).format(at);
    const readerTz = usableTimeZone(options.viewerTimeZone);
    const readersClock =
        localFormatter('stamp', tz, options.locale).format(at) ===
        localFormatter('stamp', readerTz, options.locale).format(at);
    const zoneName = readersClock
        ? undefined
        : localFormatter('zone', tz, options.locale)
              .formatToParts(at)
              .find((part) => part.type === 'timeZoneName')?.value;
    return `${day} · ${time}${zoneName ? ` ${zoneName}` : ''}`;
}

// ── Recovered departure / arrival waypoints ─────────────────────────

const RECOVERED_ROLES: Record<string, string> = {
    'recovered departure': 'Departed',
    'recovered arrival': 'Arrived',
};

/** The 15 Sep recovery's first fix: 'Recovered GPS track · Newport to Gladstone'. */
const RECOVERED_TRACK_START = /^Recovered GPS track(?: · .*)?$/i;

/**
 * Bookkeeping pins that are not marks anyone dropped: the app's rolling
 * 'Latest Position' and the 23 Sep recovery's mid-track provenance note.
 * The server drops them too; this covers a server that does not yet.
 */
const HIDDEN_PUBLIC_WAYPOINTS = new Set(['latest position', 'app recording began · original mark']);

/** True for a waypoint the public map never labels (see HIDDEN_PUBLIC_WAYPOINTS). */
export function isHiddenPublicWaypoint(name: string): boolean {
    return HIDDEN_PUBLIC_WAYPOINTS.has(name.trim().replace(/\s+/g, ' ').toLowerCase());
}

/**
 * A map waypoint's two label lines. '<Place> · recovered departure' reads
 * place '<Place>', role 'Departed Sat 26 Sep · 08:42'; '· recovered arrival'
 * reads 'Arrived …'. Those timestamps are when the boat actually moved.
 * 'Recovered GPS track · …' (the 15 Sep recovery's first fix, taken with
 * the boat already making 6 kn off Newport) reads place 'Departed', role
 * 'Tue 15 Sep · 12:28': its name holds no place field, so none is invented.
 * Every other name ('Voyage Start', 'Voyage End') keeps splitWaypointName's
 * lines exactly: a Voyage Start time is when tracking began, which can be
 * half a day before she left the berth.
 */
export function waypointLabel(
    waypoint: Pick<VoyageLogWaypoint, 'name' | 'timestamp' | 'time_zone'>,
    options: LocalDateOptions = {},
): { place: string; role: string | null } {
    if (RECOVERED_TRACK_START.test(waypoint.name.trim())) {
        return { place: 'Departed', role: formatLocalMoment(waypoint.timestamp, waypoint.time_zone, options) };
    }
    const split = splitWaypointName(waypoint.name);
    const verb = split.role ? RECOVERED_ROLES[split.role.toLowerCase()] : undefined;
    if (!verb) return split;
    const when = formatLocalMoment(waypoint.timestamp, waypoint.time_zone, options);
    return { place: split.place, role: when ? `${verb} ${when}` : verb };
}

// ── The trip picker's words ─────────────────────────────────────────

const cleanPlace = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : null;

export interface TripSummary {
    /** Server-named ends; null (or absent on older servers) stays null. */
    from: string | null;
    to: string | null;
    /** 'Hamilton Island → Airlie Beach', 'From Hamilton Island',
     *  'To Airlie Beach', or the local date when neither end is named.
     *  Never 'Departed …': started_at is when tracking began, which can be
     *  half a day before she left, and the date sits right beside it. */
    headline: string;
    /** The same words for a screen reader: '→' is read as 'to'. */
    spokenHeadline: string;
    /** True when the headline names a place rather than a date. */
    named: boolean;
    /** 'Sat 26 Sep' where the trip started; null without a usable start. */
    date: string | null;
    /** '17.2 nm'; null without a positive distance. */
    distance: string | null;
}

/**
 * What a trip is called in the picker and on its chip. Places come only
 * from the server's from_name/to_name; the date is built from started_at
 * in the trip's own zone, never from the UTC-built label, which is kept as
 * the last fallback for a trip with no usable start.
 */
export function tripSummary(trip: PublicVoyageTrip, options: LocalDateOptions = {}): TripSummary {
    const from = cleanPlace(trip.from_name);
    const to = cleanPlace(trip.to_name);
    const date = formatLocalDay(trip.started_at, trip.time_zone, options);
    const distance = positiveNm(trip.distance_nm) ? `${formatNm(trip.distance_nm)} nm` : null;
    const undated = stripTrackPrefix(trip.label ?? '').trim() || 'Trip';
    const headline = from && to ? `${from} → ${to}` : from ? `From ${from}` : to ? `To ${to}` : (date ?? undated);
    const spokenHeadline = from && to ? `${from} to ${to}` : headline;
    return { from, to, headline, spokenHeadline, named: !!(from || to), date, distance };
}

const AUTO_DATE_TITLE =
    /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day [0-9]{1,2} [A-Z][a-z]+ [0-9]{4} · [0-9]{1,2}:[0-9]{2}$/;

/** True for the app's automatic entry titles, e.g. 'Tuesday 22 September 2026 · 09:15'. */
export function isAutoDateTitle(title: string): boolean {
    return AUTO_DATE_TITLE.test(title.trim());
}

export type LabelSide = 'below' | 'above' | 'left' | 'right';

/**
 * Which side of a map marker its label should sit on so it stays inside the
 * frame: toward the middle near the left or right edge, above near the
 * bottom, otherwise below. Without a projected point or frame, 'below'.
 */
export function labelSide(
    point: { x: number; y: number } | null,
    frame: { width: number; height: number } | null,
    room = 120,
): LabelSide {
    if (!point || !frame) return 'below';
    if (point.x < room) return 'right';
    if (point.x > frame.width - room) return 'left';
    if (point.y > frame.height - 96) return 'above';
    return 'below';
}

export interface PassageStatPart {
    value: string;
    unit?: string;
}

export interface PassageStat {
    key: 'distance' | 'elapsed' | 'journey' | 'first' | 'stories';
    label: string;
    parts: PassageStatPart[];
    note?: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * A duration as display parts: '45 m', '2 h 33 m', '3 d 4 h'. Null for
 * anything that is not a finite span of at least one minute, so a tile is
 * dropped rather than showing a zero.
 */
export function formatDurationParts(ms: number): PassageStatPart[] | null {
    if (!Number.isFinite(ms) || ms < MINUTE_MS) return null;
    const totalMinutes = Math.floor(ms / MINUTE_MS);
    if (ms < HOUR_MS) return [{ value: String(totalMinutes), unit: 'm' }];
    const totalHours = Math.floor(totalMinutes / 60);
    if (ms < 48 * HOUR_MS) {
        const minutes = totalMinutes % 60;
        const parts: PassageStatPart[] = [{ value: String(totalHours), unit: 'h' }];
        if (minutes > 0) parts.push({ value: String(minutes), unit: 'm' });
        return parts;
    }
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const parts: PassageStatPart[] = [{ value: String(days), unit: 'd' }];
    if (hours > 0) parts.push({ value: String(hours), unit: 'h' });
    return parts;
}

/** Nautical miles for display: one decimal under 100 nm, whole and grouped above. */
export function formatNm(nm: number): string {
    return nm >= 100 ? Math.round(nm).toLocaleString() : nm.toFixed(1);
}

const positiveNm = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;

const partsText = (parts: PassageStatPart[]): string =>
    parts.map((part) => (part.unit ? `${part.value} ${part.unit}` : part.value)).join(' ');

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The shared tracks, their summed distance and the earliest-started one. */
function journeyTotals(trips: PublicVoyageTrip[]): {
    tracks: PublicVoyageTrip[];
    total: number;
    first: PublicVoyageTrip | null;
} {
    const tracks = trips.filter((trip) => trip.kind === 'track');
    let total = 0;
    let first: PublicVoyageTrip | null = null;
    let firstMs = Number.POSITIVE_INFINITY;
    for (const trip of tracks) {
        if (positiveNm(trip.distance_nm)) total += trip.distance_nm;
        const started = trip.started_at ? Date.parse(trip.started_at) : Number.NaN;
        if (Number.isFinite(started) && started < firstMs) {
            first = trip;
            firstMs = started;
        }
    }
    return { tracks, total, first };
}

/** '15 Sep': the first track's start, in its own zone like the picker's card. */
const firstTrackDay = (first: PublicVoyageTrip | null, nowMs: number): string | null =>
    first
        ? formatLocalDay(first.started_at, first.time_zone, { fallbackZone: DIARY_TIME_ZONE, nowMs, weekday: false })
        : null;

/** Start to finish for an ended trip; null when either end is unusable. */
function endedTripDuration(trip: PublicVoyageTrip): PassageStatPart[] | null {
    if (!trip.started_at || !trip.ended_at) return null;
    return formatDurationParts(Date.parse(trip.ended_at) - Date.parse(trip.started_at));
}

/**
 * The passage facts tiles. Journey mode: whole distance, the first track's
 * date and the story count. Trip mode: this trip's distance, its elapsed
 * time, and the whole journey when there is more than one track. A tile
 * whose inputs are missing is left out; there are never zero placeholders.
 *
 * Deliberately no average speed: start-to-finish time includes anchorages,
 * so a mean over it would understate how the boat actually sailed.
 */
export function passageFacts({
    trip,
    trips,
    nowMs,
    journey,
    entryCount,
}: {
    trip: PublicVoyageTrip | null;
    trips: PublicVoyageTrip[];
    nowMs: number;
    journey: boolean;
    entryCount: number;
}): PassageStat[] {
    const { tracks, total, first } = journeyTotals(trips);
    const stats: PassageStat[] = [];

    if (journey) {
        if (total > 0) {
            stats.push({
                key: 'distance',
                label: 'Distance',
                parts: [{ value: formatNm(total), unit: 'nm' }],
                note: plural(tracks.length, 'shared track'),
            });
        }
        const firstDay = firstTrackDay(first, nowMs);
        if (firstDay) {
            stats.push({ key: 'first', label: 'First track', parts: [{ value: firstDay }] });
        }
        if (entryCount > 0) {
            stats.push({ key: 'stories', label: 'Stories', parts: [{ value: String(entryCount) }] });
        }
        return stats;
    }

    if (!trip) return stats;

    if (positiveNm(trip.distance_nm)) {
        stats.push({ key: 'distance', label: 'Distance', parts: [{ value: formatNm(trip.distance_nm), unit: 'nm' }] });
    }

    const start = trip.started_at ? Date.parse(trip.started_at) : Number.NaN;
    const end = trip.ended_at ? Date.parse(trip.ended_at) : trip.active ? nowMs : Number.NaN;
    const elapsed = formatDurationParts(end - start);
    if (elapsed) {
        stats.push({ key: 'elapsed', label: trip.ended_at ? 'Start to finish' : 'Time so far', parts: elapsed });
    }

    if (tracks.length >= 2 && total > 0) {
        const firstDay = firstTrackDay(first, nowMs);
        const since = firstDay ? ` · since ${firstDay}` : '';
        stats.push({
            key: 'journey',
            label: 'Whole journey',
            parts: [{ value: formatNm(total), unit: 'nm' }],
            note: `${tracks.length} tracks${since}`,
        });
    }

    return stats;
}

/**
 * One line for the map key: '17.2 nm · 2 h 33 m', '4.1 nm so far' or
 * '656 nm · 7 tracks'. Never reads the clock, so a memoised map does not
 * re-render on the dashboard's 30 s tick.
 */
export function passageKeySummary({
    trip,
    trips,
    journey,
}: {
    trip: PublicVoyageTrip | null;
    trips: PublicVoyageTrip[];
    journey: boolean;
}): string | null {
    if (journey) {
        const { tracks, total } = journeyTotals(trips);
        return total > 0 ? `${formatNm(total)} nm · ${plural(tracks.length, 'track')}` : null;
    }
    if (!trip || !positiveNm(trip.distance_nm)) return null;
    const nm = formatNm(trip.distance_nm);
    if (!trip.ended_at) return `${nm} nm so far`;
    const duration = endedTripDuration(trip);
    return duration ? `${nm} nm · ${partsText(duration)}` : `${nm} nm`;
}
