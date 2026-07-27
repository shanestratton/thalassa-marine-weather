/**
 * Passage Summary schedule — one honest calculation for the route card.
 *
 * A planned passage should never depend on a previously calculated chart
 * route's cached ETA. The saved polyline and the vessel's cruising speed are
 * the source of truth:
 *
 *   distance = sum of the saved route legs
 *   duration = distance / cruising speed
 *   ETA      = departure + duration
 *
 * Keeping this pure also makes the time floor testable. The UI can refresh
 * `now` as the clock moves without inventing a second scheduling rule.
 */

import { cumulativeLegs, haversineNm } from './isochrone/geodesy';

export interface PassageRoutePoint {
    lat: number;
    lon: number;
}

export interface PassageSummarySchedule {
    /** Valid local/device-time departure, never earlier than now. */
    departureTime: string;
    /** Total NM on the saved curve (or a supplied verified fallback). */
    distanceNm: number | null;
    /** Vessel-profile cruise speed after validation. */
    cruisingSpeedKt: number;
    /** distance / cruising speed, when distance is known. */
    durationHours: number | null;
    /** departure + duration, when distance is known. */
    eta: string | null;
}

export const DEFAULT_CRUISING_SPEED_KT = 6;
const MIN_CRUISING_SPEED_KT = 0.5;
const MAX_CRUISING_SPEED_KT = 30;
const DEFAULT_SLOT_MINUTES = 5;

const isValidPoint = (point: PassageRoutePoint | null | undefined): point is PassageRoutePoint =>
    Boolean(
        point &&
        Number.isFinite(point.lat) &&
        Number.isFinite(point.lon) &&
        Math.abs(point.lat) <= 90 &&
        Math.abs(point.lon) <= 180,
    );

export function verifiedCruisingSpeedKt(value: number | null | undefined): number {
    return typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= MIN_CRUISING_SPEED_KT &&
        value <= MAX_CRUISING_SPEED_KT
        ? value
        : DEFAULT_CRUISING_SPEED_KT;
}

/** Round up to the next selectable local-time slot. */
export function nextDepartureSlot(now = new Date(), slotMinutes = DEFAULT_SLOT_MINUTES): Date {
    const validSlot = Number.isFinite(slotMinutes) && slotMinutes > 0 ? Math.floor(slotMinutes) : DEFAULT_SLOT_MINUTES;
    const slotMs = validSlot * 60_000;
    return new Date(Math.ceil(now.getTime() / slotMs) * slotMs);
}

/**
 * Ensures a stored/devised departure is never in the past. A missing or bad
 * value becomes the next selectable slot instead of an ambiguous blank.
 */
export function clampDepartureToNow(
    departureTime: string | null | undefined,
    now = new Date(),
    slotMinutes = DEFAULT_SLOT_MINUTES,
): string {
    const ms = departureTime ? Date.parse(departureTime) : NaN;
    if (Number.isFinite(ms) && ms >= now.getTime()) return new Date(ms).toISOString();
    return nextDepartureSlot(now, slotMinutes).toISOString();
}

const pad2 = (value: number) => String(value).padStart(2, '0');

type DateValue = string | Date | null | undefined;

const dateMilliseconds = (value: DateValue): number =>
    value instanceof Date ? value.getTime() : value ? Date.parse(value) : NaN;

/** Format an ISO timestamp for a native local <input type="time">. */
export function localTimeValue(iso: DateValue): string {
    const ms = dateMilliseconds(iso);
    if (!Number.isFinite(ms)) return '';
    const date = new Date(ms);
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Format an ISO timestamp for a native local <input type="datetime-local">. */
export function localDateTimeValue(iso: DateValue): string {
    const ms = dateMilliseconds(iso);
    if (!Number.isFinite(ms)) return '';
    const date = new Date(ms);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${localTimeValue(iso)}`;
}

export function localDateValue(iso: DateValue): string {
    const ms = dateMilliseconds(iso);
    if (!Number.isFinite(ms)) return '';
    const date = new Date(ms);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function sameLocalDate(left: Date, right: Date): boolean {
    return (
        left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate()
    );
}

/**
 * The native time picker only needs a min for today. A future date must stay
 * fully selectable; a past date is clamped before it reaches the control.
 */
export function localDepartureTimeMin(departureTime: string | null | undefined, now = new Date()): string | undefined {
    const ms = departureTime ? Date.parse(departureTime) : NaN;
    if (!Number.isFinite(ms) || !sameLocalDate(new Date(ms), now)) return undefined;
    return localTimeValue(nextDepartureSlot(now));
}

/**
 * Rebuild a full ISO timestamp from a local time-picker value. The selected
 * date comes from the current departure; if there is none, it starts today.
 */
export function departureAtLocalTime(
    currentDeparture: string | null | undefined,
    hhmm: string,
    now = new Date(),
): string {
    const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
    if (!match) return clampDepartureToNow(currentDeparture, now);
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return clampDepartureToNow(currentDeparture, now);

    const currentMs = currentDeparture ? Date.parse(currentDeparture) : NaN;
    const base = Number.isFinite(currentMs) ? new Date(currentMs) : now;
    const local = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hours, minutes, 0, 0);
    return clampDepartureToNow(local.toISOString(), now);
}

/**
 * Rebuild a full ISO timestamp from a local YYYY-MM-DD date-picker value,
 * retaining the departure's local time where possible.
 */
export function departureOnLocalDate(
    yyyymmdd: string,
    currentDeparture: string | null | undefined,
    now = new Date(),
): string | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const currentMs = currentDeparture ? Date.parse(currentDeparture) : NaN;
    const current = Number.isFinite(currentMs) ? new Date(currentMs) : nextDepartureSlot(now);
    const local = new Date(year, month, day, current.getHours(), current.getMinutes(), 0, 0);
    // Date() normalises malformed dates (e.g. 2026-02-31); refuse those
    // rather than silently moving a vessel into another month.
    if (local.getFullYear() !== year || local.getMonth() !== month || local.getDate() !== day) return null;
    return clampDepartureToNow(local.toISOString(), now);
}

export function routeDistanceNm(points: readonly PassageRoutePoint[] | null | undefined): number | null {
    const valid = (points ?? []).filter(isValidPoint);
    if (valid.length < 2) return null;
    const legs = cumulativeLegs(valid, DEFAULT_CRUISING_SPEED_KT);
    const distance = legs[legs.length - 1]?.nm;
    return distance != null && Number.isFinite(distance) && distance > 0 ? distance : null;
}

/** Direct endpoint distance only when a saved polyline is unavailable. */
export function greatCircleDistanceNm(
    departure: PassageRoutePoint | null | undefined,
    arrival: PassageRoutePoint | null | undefined,
): number | null {
    if (!isValidPoint(departure) || !isValidPoint(arrival)) return null;
    const distance = haversineNm(departure.lat, departure.lon, arrival.lat, arrival.lon);
    return Number.isFinite(distance) && distance > 0 ? distance : null;
}

export function derivePassageSummarySchedule({
    routeCoordinates,
    fallbackDistanceNm,
    departureTime,
    cruisingSpeedKt,
    now,
}: {
    routeCoordinates?: readonly PassageRoutePoint[] | null;
    /** Only use values tied to this exact saved route. */
    fallbackDistanceNm?: number | null;
    departureTime?: string | null;
    cruisingSpeedKt?: number | null;
    now?: Date;
}): PassageSummarySchedule {
    const departure = clampDepartureToNow(departureTime, now);
    const routeDistance = routeDistanceNm(routeCoordinates);
    const fallback =
        typeof fallbackDistanceNm === 'number' && Number.isFinite(fallbackDistanceNm) && fallbackDistanceNm > 0
            ? fallbackDistanceNm
            : null;
    const distanceNm = routeDistance ?? fallback;
    const speed = verifiedCruisingSpeedKt(cruisingSpeedKt);
    const durationHours = distanceNm == null ? null : distanceNm / speed;
    const departureMs = Date.parse(departure);
    const eta =
        durationHours != null && Number.isFinite(departureMs)
            ? new Date(departureMs + durationHours * 3_600_000).toISOString()
            : null;
    return { departureTime: departure, distanceNm, cruisingSpeedKt: speed, durationHours, eta };
}

export function formatPassageDuration(hours: number | null | undefined): string {
    if (hours == null || !Number.isFinite(hours) || hours <= 0) return '--';
    const totalMinutes = Math.max(1, Math.round(hours * 60));
    const days = Math.floor(totalMinutes / (24 * 60));
    const remainingMinutes = totalMinutes - days * 24 * 60;
    const wholeHours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    if (days > 0) return `${days}d ${wholeHours}h`;
    if (wholeHours > 0) return minutes > 0 ? `${wholeHours}h ${minutes}m` : `${wholeHours}h`;
    return `${minutes}min`;
}
