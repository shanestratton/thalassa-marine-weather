/**
 * Pure helpers that turn the public voyage payload into the words and numbers
 * the page tells its followers: the last-known flag, the instruments line,
 * the trip chip, waypoint labels and the passage facts.
 *
 * No React and no JSX here. Every surface that says the same thing (the map
 * flag and the header, the hero tiles and the diary chapter head) imports it
 * from this one module, so they can never disagree about wording or maths.
 */
import type { PublicVoyageTrip, VoyageLogInstruments, VoyageLogTelemetry, VoyageLogTrackPoint } from '../voyageLogApi';
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

const SHORT_DAY_MONTH = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

const positiveNm = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;

const partsText = (parts: PassageStatPart[]): string =>
    parts.map((part) => (part.unit ? `${part.value} ${part.unit}` : part.value)).join(' ');

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The shared tracks, their summed distance and the earliest start. */
function journeyTotals(trips: PublicVoyageTrip[]): {
    tracks: PublicVoyageTrip[];
    total: number;
    first: number | null;
} {
    const tracks = trips.filter((trip) => trip.kind === 'track');
    let total = 0;
    let first: number | null = null;
    for (const trip of tracks) {
        if (positiveNm(trip.distance_nm)) total += trip.distance_nm;
        const started = trip.started_at ? Date.parse(trip.started_at) : Number.NaN;
        if (Number.isFinite(started) && (first === null || started < first)) first = started;
    }
    return { tracks, total, first };
}

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
        if (first !== null) {
            stats.push({ key: 'first', label: 'First track', parts: [{ value: SHORT_DAY_MONTH.format(first) }] });
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
        const since = first !== null ? ` · since ${SHORT_DAY_MONTH.format(first)}` : '';
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
