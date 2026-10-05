/**
 * Words and numbers for the Sightings screens: one place for how a sighting
 * is named, timed and placed, so the sheet, the feeds and the detail agree.
 */
import { formatLatDegMin, formatLonDegMin } from '../../utils/formatDegMin';
import {
    ANONYMOUS_CREDIT,
    SIGHTING_GROUP_LABELS,
    type LocalSighting,
    type PublicSighting,
    type ServerSightingRow,
    type SightingGroup,
    type SightingPositionSource,
    type SightingSyncState,
    type SightingVisibility,
} from '../../services/sightings/types';

/** One sighting as every list draws it, whoever's it is and wherever it came from. */
export interface SightingItem {
    id: string;
    group: SightingGroup;
    scientificName: string | null;
    vernacularName: string | null;
    count: number;
    hasCalf: boolean;
    eventDate: string;
    latitude: number | null;
    longitude: number | null;
    visibility: SightingVisibility | 'public-feed';
    observerId: string | null;
    observerDisplay: string | null;
    positionSource: SightingPositionSource | null;
    vesselOwnerId: string | null;
    voyageId: string | null;
    /** Your own record on this phone (editable). */
    local: LocalSighting | null;
    /** A crew row from the server (read only unless it is yours). */
    server: ServerSightingRow | null;
    /** A public row: fuzzed, late, anonymous unless credited. */
    publicRow: PublicSighting | null;
    syncState: SightingSyncState | null;
}

export function itemFromLocal(record: LocalSighting): SightingItem {
    const r = record.row;
    return {
        id: record.id,
        group: r.taxon_group,
        scientificName: r.scientific_name,
        vernacularName: record.vernacularName,
        count: r.individual_count,
        hasCalf: r.has_calf,
        eventDate: r.event_date,
        latitude: r.decimal_latitude,
        longitude: r.decimal_longitude,
        visibility: r.visibility,
        observerId: r.observer_id,
        observerDisplay: r.observer_display,
        positionSource: r.position_source,
        vesselOwnerId: r.vessel_owner_id,
        voyageId: r.voyage_id,
        local: record,
        server: null,
        publicRow: null,
        syncState: record.sync.state,
    };
}

export function itemFromServer(row: ServerSightingRow): SightingItem {
    return {
        id: row.id,
        group: row.taxon_group,
        scientificName: row.scientific_name,
        vernacularName: row.vernacular_name,
        count: row.individual_count,
        hasCalf: row.has_calf,
        eventDate: row.event_date,
        latitude: row.decimal_latitude,
        longitude: row.decimal_longitude,
        visibility: row.visibility,
        observerId: row.observer_id,
        observerDisplay: row.observer_display,
        positionSource: row.position_source,
        vesselOwnerId: row.vessel_owner_id,
        voyageId: row.voyage_id,
        local: null,
        server: row,
        publicRow: null,
        syncState: null,
    };
}

export function itemFromPublic(row: PublicSighting): SightingItem {
    return {
        id: row.sighting_id,
        group: row.taxon_group,
        scientificName: row.scientific_name,
        vernacularName: row.vernacular_name,
        count: row.individual_count,
        hasCalf: row.has_calf,
        eventDate: row.event_time,
        latitude: row.latitude,
        longitude: row.longitude,
        visibility: 'public-feed',
        observerId: null,
        observerDisplay: row.credit ?? ANONYMOUS_CREDIT,
        positionSource: null,
        vesselOwnerId: null,
        voyageId: null,
        local: null,
        server: null,
        publicRow: row,
        syncState: null,
    };
}

/** "Humpback whale", else the group: "Whale". */
export function sightingName(item: Pick<SightingItem, 'vernacularName' | 'scientificName' | 'group'>): string {
    return item.vernacularName || item.scientificName || SIGHTING_GROUP_LABELS[item.group];
}

/** "Humpback whale × 2 · calf". */
export function sightingTitle(item: SightingItem): string {
    const name = sightingName(item);
    const count = item.count > 1 ? ` × ${item.count}` : '';
    return `${name}${count}${item.hasCalf ? ' · calf' : ''}`;
}

const PLURALS: Record<SightingGroup, [string, string]> = {
    whale: ['whale', 'whales'],
    dolphin: ['dolphin', 'dolphins'],
    dugong: ['dugong', 'dugongs'],
    turtle: ['turtle', 'turtles'],
    seabird: ['seabird', 'seabirds'],
    shark_ray: ['shark or ray', 'sharks or rays'],
    fish: ['fish', 'fish'],
    other: ['animal', 'animals'],
};

/** "2 whales · calf with them". */
export function countLine(item: SightingItem): string {
    const [one, many] = PLURALS[item.group];
    return `${item.count} ${item.count === 1 ? one : many}${item.hasCalf ? ' · calf with them' : ''}`;
}

export function formatPosition(lat: number | null, lon: number | null): string | null {
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
    }
    return `${formatLatDegMin(lat, 1)} ${formatLonDegMin(lon, 1).replace(/^0+(?=\d)/, '')}`;
}

export function formatClock(iso: string | number): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Today / Yesterday / "Sat 3 Oct". */
export function dayLabel(iso: string, now = Date.now()): string {
    const d = new Date(iso);
    const today = new Date(now);
    const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOf(today) - startOf(d)) / 86_400_000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function formatDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "3 h ago", "yesterday", "4 d ago". */
export function agoLabel(iso: string, now = Date.now()): string {
    const ms = now - Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    const h = Math.floor(ms / 3_600_000);
    if (h < 1) return 'under an hour ago';
    if (h < 24) return `${h} h ago`;
    const d = Math.floor(h / 24);
    return d === 1 ? 'yesterday' : `${d} d ago`;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Wind is reported by where it comes FROM: 135° reads "SE". */
export function compassPoint(deg: number | null | undefined): string {
    if (typeof deg !== 'number' || !Number.isFinite(deg)) return '';
    return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

export const POSITION_SOURCE_LABEL: Record<SightingPositionSource, string> = {
    bus: 'Boat GPS',
    pi: 'Boat GPS (via Pi)',
    cloud: 'Boat GPS (via cloud)',
    phone: 'Phone GPS',
};

/**
 * The CC-BY credit for a forecast value, by agency: "Forecast data: ECMWF".
 * wx_model keeps the app's own source tag ('openmeteo_ecmwf_ifs025',
 * 'stormglass_gfs+fallback:…') for the phase 3 export; people see who made
 * the numbers. A tag nobody recognises is shown as it is, never dropped.
 */
const CREDITS: Array<[RegExp, string]> = [
    [/ecmwf/i, 'ECMWF'],
    [/icon|dwd/i, 'DWD'],
    [/ukmo|metoffice/i, 'UKMO'],
    [/jma/i, 'JMA'],
    [/meteofrance|arpege|arome/i, 'Météo-France'],
    [/gfs|ncep|noaa/i, 'NOAA'],
    [/gem|cmc/i, 'ECCC'],
    [/access|bom/i, 'BOM'],
    [/spitfire/i, 'ECMWF, DWD, UKMO, JMA, Météo-France, NOAA'],
    [/weatherkit|(^|\+)wk(\+|$)/i, 'Apple Weather'],
    [/stormglass|(^|\+)sg(\+|$)/i, 'StormGlass'],
];

export function forecastCredit(model: string | null | undefined): string {
    const tag = model?.trim();
    if (!tag) return 'Forecast data';
    const names = [...new Set(CREDITS.filter(([re]) => re.test(tag)).map(([, name]) => name))];
    return `Forecast data: ${names.length ? names.join(', ') : tag}`;
}

/** "~1 km area" from the server's reported uncertainty. */
export function areaLabel(uncertaintyM: number): string {
    if (uncertaintyM >= 5000) return `~${Math.round(uncertaintyM / 1000)} km area`;
    if (uncertaintyM >= 700) return '~1 km area';
    return `~${Math.round(uncertaintyM / 100) * 100} m area`;
}

/** Who logged it, for a crew byline. */
export function observerLabel(item: SightingItem, myUserId: string | null): string {
    if (item.observerId && item.observerId === myUserId) return 'You';
    return item.observerDisplay || 'Crew';
}

export const SYNC_LABEL: Partial<Record<SightingSyncState, string>> = {
    pending: 'Waiting to send',
    held: 'Saved on this phone',
    failed: 'Not sent: open to see why',
    'needs-position': 'Needs a position: open to add it',
};

/**
 * Why a sighting is 'failed' (the server refused it, or it is too old to
 * send), and whether trying again could help. It always stays on this phone.
 */
export function failedReason(lastError: string | null | undefined): { text: string; retryable: boolean } {
    if (lastError === 'too-old') {
        return {
            text: 'Older than 60 days, so the server won’t take it. It stays on this phone.',
            retryable: false,
        };
    }
    return {
        text: 'The server didn’t accept it. It stays on this phone; try again, or delete it.',
        retryable: true,
    };
}
