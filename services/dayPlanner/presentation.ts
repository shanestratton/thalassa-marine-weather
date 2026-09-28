/** Legacy callers retain Queensland civil time; regional callers pass an IANA zone. */
export const DAY_PLAN_TIME_ZONE = 'Australia/Brisbane';
const HOUR_MS = 3_600_000;
interface CivilTime {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}
const partFormatters = new Map<string, Intl.DateTimeFormat>();

export function isDayPlanTimeZone(zone: unknown): zone is string {
    if (typeof zone !== 'string' || !zone || zone !== zone.trim() || zone.length > 100 || /^[+-]/.test(zone))
        return false;
    try {
        new Intl.DateTimeFormat('en-GB', { timeZone: zone }).format(0);
        return true;
    } catch {
        return false;
    }
}

function formatter(zone: string): Intl.DateTimeFormat | undefined {
    const cached = partFormatters.get(zone);
    if (cached) return cached;
    if (!isDayPlanTimeZone(zone)) return undefined;
    const value = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });
    if (partFormatters.size >= 64) partFormatters.delete(partFormatters.keys().next().value!);
    partFormatters.set(zone, value);
    return value;
}

function civilTime(ms: number, zone: string): CivilTime | undefined {
    if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) return undefined;
    const format = formatter(zone);
    if (!format) return undefined;
    const fields = Object.fromEntries(format.formatToParts(ms).map(({ type, value }) => [type, Number(value)]));
    return {
        year: fields.year,
        month: fields.month,
        day: fields.day,
        hour: fields.hour,
        minute: fields.minute,
        second: fields.second,
    };
}

function civilAsUTC(value: CivilTime): number {
    const date = new Date(0);
    date.setUTCFullYear(value.year, value.month - 1, value.day);
    date.setUTCHours(value.hour, value.minute, value.second, 0);
    return date.getTime();
}
const pad = (value: number, size = 2) => String(value).padStart(size, '0');
const civilDate = (value: CivilTime) => `${pad(value.year, 4)}-${pad(value.month)}-${pad(value.day)}`;
const civilInput = (value: CivilTime) => `${civilDate(value)}T${pad(value.hour)}:${pad(value.minute)}`;

export function dayPlanLocalDate(ms: number, zone = DAY_PLAN_TIME_ZONE): string {
    const parts = civilTime(ms, zone);
    return parts ? civilDate(parts) : '';
}

export function dayPlanInputTime(ms: number, zone = DAY_PLAN_TIME_ZONE): string {
    const parts = civilTime(ms, zone);
    return parts ? civilInput(parts) : '';
}

/** Accept exactly one instant for a local wall time. Daylight-saving gaps and
 * folds are rejected instead of silently choosing or shifting an instant. */
export function parseDayPlanInput(value: string, zone = DAY_PLAN_TIME_ZONE): number {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!match || !formatter(zone)) return NaN;
    const [year, month, day, hour, minute] = match.slice(1).map(Number);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return NaN;
    const wall = civilAsUTC({ year, month, day, hour, minute, second: 0 });
    const normalized = new Date(wall);
    if (
        normalized.getUTCFullYear() !== year ||
        normalized.getUTCMonth() + 1 !== month ||
        normalized.getUTCDate() !== day
    )
        return NaN;
    // Collect offsets on both sides of nearby IANA transitions. The 72-hour
    // span also covers half-hour transitions and whole-date dateline changes.
    const offsets = new Set<number>();
    for (let delta = -36; delta <= 36; delta++) {
        const sample = wall + delta * HOUR_MS;
        const local = civilTime(sample, zone)!;
        offsets.add(civilAsUTC(local) - sample);
    }
    const matches = [...offsets]
        .map((offset) => wall - offset)
        .filter((ms) => {
            const local = civilTime(ms, zone);
            return local?.second === 0 && civilInput(local) === value;
        });
    return matches.length === 1 ? matches[0] : NaN;
}

export function dayPlanTime(ms: number, zone = DAY_PLAN_TIME_ZONE): string {
    if (!civilTime(ms, zone)) return '';
    return new Intl.DateTimeFormat('en-AU', {
        timeZone: zone,
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
    }).format(ms);
}

/** Explicit IANA identity plus the abbreviation and offset at this instant. */
export function dayPlanTimeZoneLabel(ms: number, zone = DAY_PLAN_TIME_ZONE): string {
    const local = civilTime(ms, zone);
    if (!local) return '';
    const seconds = Math.round((civilAsUTC(local) - Math.floor(ms / 1000) * 1000) / 1000);
    const absolute = Math.abs(seconds);
    const offset = `UTC${seconds < 0 ? '-' : '+'}${pad(Math.floor(absolute / 3600))}:${pad(Math.floor((absolute % 3600) / 60))}${absolute % 60 ? `:${pad(absolute % 60)}` : ''}`;
    const abbreviation = new Intl.DateTimeFormat('en-AU', { timeZone: zone, timeZoneName: 'short' })
        .formatToParts(ms)
        .find((part) => part.type === 'timeZoneName')?.value;
    return [zone, abbreviation, offset].filter(Boolean).join(' · ');
}

export function dayPlanDateTime(ms: number, zone = DAY_PLAN_TIME_ZONE): string {
    const label = dayPlanTimeZoneLabel(ms, zone);
    return label
        ? `${new Intl.DateTimeFormat('en-AU', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(ms)} [${label}]`
        : '';
}

/** Nine o'clock on the next local calendar date, not 24 elapsed hours later. */
export function nextLocalMorning(ms: number, zone = DAY_PLAN_TIME_ZONE, hour = 9): number {
    const local = civilTime(ms, zone);
    if (!local || !Number.isInteger(hour) || hour < 0 || hour > 23) return NaN;
    const next = new Date(civilAsUTC({ ...local, day: local.day + 1, hour, minute: 0, second: 0 }));
    return parseDayPlanInput(
        `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T${pad(hour)}:00`,
        zone,
    );
}
export function dayPlanDuration(hours: number): string {
    const minutes = Math.round(hours * 60);
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
