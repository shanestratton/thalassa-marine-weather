import {
    parseRadarSentence,
    qualifyRadarReport,
    radarObservationTime,
    validRadarFeedId,
    RADAR_TARGET_CAP,
    RADAR_REPORT_MAX_AGE_MS,
    type RadarContact,
    type RadarOwnship,
    type RadarReport,
} from './radarTarget.js';

/** Short, bounded history; collision encounters retain their own unresolved lost state. */
export const RADAR_HISTORY_MS = 120_000;
export interface RadarObservationEvidence {
    sentence: string;
    receivedAt: number;
    evaluatedAt: number;
    ownship: RadarOwnship;
}
interface Observation extends RadarObservationEvidence {
    report: RadarReport;
    /** Captured at ingress: later yaw/navigation must not move an old relative echo. */
    ownship: RadarOwnship;
    solution: RadarContact;
}
interface Track {
    TTM?: Observation;
    TLL?: Observation;
}
const decimal = (raw: string | undefined): number | null =>
    raw && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : null;
const within = (value: number | null, min: number, max: number): value is number =>
    value !== null && value >= min && value <= max;
const angle = (raw: string | undefined): number | null => {
    const value = decimal(raw);
    return within(value, 0, 360) ? value % 360 : null;
};
function coordinate(raw: string | undefined, side: string | undefined, lat: boolean): number | null {
    if (!raw || !(lat ? /^\d{4}(?:\.\d+)?$/ : /^\d{5}(?:\.\d+)?$/).test(raw)) return null;
    if (!(lat ? ['N', 'S'] : ['E', 'W']).includes(side ?? '')) return null;
    const encoded = Number(raw),
        degrees = Math.floor(encoded / 100),
        minutes = encoded - degrees * 100;
    const value = degrees + minutes / 60;
    return minutes < 60 && value <= (lat ? 90 : 180) ? (side === 'S' || side === 'W' ? -1 : 1) * value : null;
}
function fieldsOf(raw: unknown): string[] | null {
    if (
        typeof raw !== 'string' ||
        raw.length > 256 ||
        !/^\$[A-Z0-9]{2}[A-Z]{3},[\x20-\x7e]*\*[0-9a-fA-F]{2}$/.test(raw)
    )
        return null;
    const star = raw.indexOf('*');
    if (star !== raw.length - 3) return null;
    let checksum = 0;
    for (let i = 1; i < star; i++) checksum ^= raw.charCodeAt(i);
    return checksum === Number.parseInt(raw.slice(star + 1), 16) ? raw.slice(0, star).split(',') : null;
}
const measuredMode = (raw: string | undefined): boolean =>
    raw === undefined || raw === '' || ['A', 'D', 'P', 'R', 'F'].includes(raw);
const newest = (track: Track): Observation =>
    [track.TTM, track.TLL]
        .filter((item): item is Observation => !!item)
        .sort((a, b) => b.report.at - a.report.at || b.report.receivedAt - a.report.receivedAt)[0];

/** One approved physical input/vessel session. No timers, provider reads or persistence. */
export class RadarFeed {
    private navigation: RadarOwnship;
    private tracks = new Map<string, Track>();
    private positionAt = 0;
    private motionAt = 0;
    private headingAt = 0;
    constructor(readonly feedId: string) {
        if (!validRadarFeedId(feedId)) throw Error('Invalid radar feed identity');
        this.navigation = { feedId, position: null, heading: null, motion: null };
    }
    reset(): void {
        this.navigation = { feedId: this.feedId, position: null, heading: null, motion: null };
        this.tracks.clear();
        this.positionAt = this.motionAt = this.headingAt = 0;
    }
    private capture(): RadarOwnship {
        const nav = this.navigation;
        return {
            feedId: this.feedId,
            position: nav.position ? { ...nav.position } : null,
            heading: nav.heading ? { ...nav.heading } : null,
            motion: nav.motion ? { ...nav.motion } : null,
        };
    }
    private prune(now: number): void {
        for (const [key, track] of this.tracks) {
            const at = newest(track).report.at;
            if (at > now + 1000 || now - at > RADAR_HISTORY_MS) this.tracks.delete(key);
        }
    }
    /** Original ingress time is supplied once by the transport, never by a later HTTP poll. */
    ingest(raw: unknown, receivedAt: number, now: number): 'target' | 'navigation' | null {
        if (
            !Number.isSafeInteger(receivedAt) ||
            receivedAt <= 0 ||
            !Number.isFinite(now) ||
            receivedAt > now + 1000 ||
            now - receivedAt > 15_000
        )
            return null;
        const report = parseRadarSentence(raw, { feedId: this.feedId, receivedAt, now });
        if (report) {
            this.prune(now);
            const track = this.tracks.get(report.contactKey) ?? {};
            const previous = track[report.sentence];
            if (
                previous &&
                (report.at < previous.report.at ||
                    (report.at === previous.report.at &&
                        (report.status === 'tracking' || report.receivedAt <= previous.report.receivedAt)))
            )
                return null;
            if (!this.tracks.has(report.contactKey) && this.tracks.size >= RADAR_TARGET_CAP) {
                const oldest = [...this.tracks].sort(
                    (a, b) => newest(a[1]).report.at - newest(b[1]).report.at || a[0].localeCompare(b[0]),
                )[0];
                this.tracks.delete(oldest[0]);
            }
            const ownship = this.capture();
            track[report.sentence] = {
                sentence: raw as string,
                receivedAt,
                evaluatedAt: now,
                report,
                ownship,
                solution: qualifyRadarReport(report, ownship, now),
            };
            this.tracks.set(report.contactKey, track);
            return 'target';
        }
        const fields = fieldsOf(raw);
        if (!fields) return null;
        const type = fields[0].slice(3);
        if (!['RMC', 'GGA', 'GLL', 'VTG', 'HDT', 'THS'].includes(type)) return null;
        const originalTime =
            type === 'RMC' || type === 'GGA' || type === 'GLL'
                ? radarObservationTime(fields[type === 'GLL' ? 5 : 1], receivedAt)
                : { at: receivedAt };
        if (!originalTime) return null;
        const at = originalTime.at;
        if (type === 'HDT' || type === 'THS') {
            if (at < this.headingAt) return null;
            this.headingAt = at;
            const trueDeg = angle(fields[1]);
            this.navigation.heading =
                trueDeg !== null && (type === 'HDT' ? fields[2] === 'T' : fields[2] === 'A') ? { trueDeg, at } : null;
        } else if (type === 'VTG') {
            if (at < this.motionAt) return null;
            this.motionAt = at;
            const knots = fields[6] === 'N' ? decimal(fields[5]) : null;
            const kmh = fields[8] === 'K' ? decimal(fields[7]) : null;
            const consistent = knots === null || kmh === null || Math.abs(knots - kmh / 1.852) <= 0.1;
            const sogKn = knots ?? (kmh === null ? null : kmh / 1.852);
            const cogTrueDeg = fields[2] === 'T' ? angle(fields[1]) : null;
            this.navigation.motion =
                measuredMode(fields[9]) && consistent && within(sogKn, 0, 100)
                    ? { sogKn, sogAt: at, cogTrueDeg, cogAt: cogTrueDeg === null ? null : at }
                    : null;
        } else {
            let valid = true;
            if (type === 'RMC') {
                valid = fields[2] === 'A' && measuredMode(fields[12]) && /^\d{6}$/.test(fields[9] ?? '');
                if (valid) {
                    const date = new Date(at);
                    valid =
                        Number(fields[9].slice(0, 2)) === date.getUTCDate() &&
                        Number(fields[9].slice(2, 4)) === date.getUTCMonth() + 1 &&
                        Number(fields[9].slice(4)) === date.getUTCFullYear() % 100;
                }
                if (at >= this.motionAt) {
                    this.motionAt = at;
                    const sogKn = decimal(fields[7]),
                        cogTrueDeg = angle(fields[8]);
                    this.navigation.motion =
                        valid && within(sogKn, 0, 100)
                            ? { sogKn, sogAt: at, cogTrueDeg, cogAt: cogTrueDeg === null ? null : at }
                            : null;
                }
            } else if (type === 'GGA') valid = ['1', '2', '3', '4', '5'].includes(fields[6]);
            else valid = fields[6] === 'A' && measuredMode(fields[7]);
            const start = type === 'RMC' ? 3 : type === 'GGA' ? 2 : 1;
            const lat = coordinate(fields[start], fields[start + 1], true),
                lon = coordinate(fields[start + 2], fields[start + 3], false);
            if (at >= this.positionAt) {
                this.positionAt = at;
                this.navigation.position = valid && lat !== null && lon !== null ? { lat, lon, at } : null;
            }
        }
        return 'navigation';
    }
    /** At most two independent observations per target. Callers group by contactKey and preserve worst risk. */
    contacts(now: number): RadarContact[] {
        if (!Number.isFinite(now)) return [];
        this.prune(now);
        const contacts: RadarContact[] = [];
        for (const track of this.tracks.values()) {
            const latest = newest(track);
            const observations =
                latest.report.status !== 'tracking'
                    ? [latest]
                    : [track.TTM, track.TLL].filter((item): item is Observation => !!item);
            for (const { solution } of observations) {
                contacts.push(ageRadarContact(solution, now));
            }
        }
        return contacts;
    }
    /** RAM-only raw evidence for the paired LAN; never re-derive an old echo from current navigation. */
    evidence(now: number): RadarObservationEvidence[] {
        if (!Number.isFinite(now)) return [];
        this.prune(now);
        const result: RadarObservationEvidence[] = [];
        for (const track of this.tracks.values()) {
            const latest = newest(track);
            const observations =
                latest.report.status !== 'tracking'
                    ? [latest]
                    : [track.TTM, track.TLL].filter((item): item is Observation => !!item);
            for (const item of observations)
                result.push({
                    sentence: item.sentence,
                    receivedAt: item.receivedAt,
                    evaluatedAt: item.evaluatedAt,
                    ownship: copyOwnship(item.ownship),
                });
        }
        return result;
    }
    ownshipSnapshot(): RadarOwnship {
        return this.capture();
    }
    get targetCount(): number {
        return this.tracks.size;
    }
}

function copyOwnship(nav: RadarOwnship): RadarOwnship {
    return {
        feedId: nav.feedId,
        position: nav.position ? { ...nav.position } : null,
        heading: nav.heading ? { ...nav.heading } : null,
        motion: nav.motion ? { ...nav.motion } : null,
    };
}
/** Aging cannot add motion, alter geometry, or renew any original clock. */
export function ageRadarContact(solution: RadarContact, now: number): RadarContact {
    const fresh =
        Number.isFinite(now) &&
        [solution.at, solution.receivedAt].every((at) => at <= now + 1000 && now - at <= RADAR_REPORT_MAX_AGE_MS);
    const motionFresh =
        fresh &&
        solution.motion &&
        solution.motion.at <= now + 1000 &&
        now - solution.motion.at <= RADAR_REPORT_MAX_AGE_MS;
    return {
        ...solution,
        position: solution.position ? { ...solution.position } : null,
        motion: motionFresh ? { ...solution.motion! } : null,
        qualifiedAt: motionFresh ? solution.qualifiedAt : null,
        motionReason: solution.motion && !motionFresh ? 'dependencies-stale' : solution.motionReason,
        fresh,
    };
}
const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const clock = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
/** Validate the dependency shape before the shared qualifier sees paired HTTP input. */
export function decodeRadarOwnship(value: unknown, feedId: string): RadarOwnship | null {
    if (!record(value) || value.feedId !== feedId || !validRadarFeedId(feedId)) return null;
    const p = value.position,
        h = value.heading,
        m = value.motion;
    if (p !== null && (!record(p) || !bounded(p.lat, -90, 90) || !bounded(p.lon, -180, 180) || !clock(p.at)))
        return null;
    if (h !== null && (!record(h) || !bounded(h.trueDeg, 0, 359.99999999999994) || !clock(h.at))) return null;
    if (
        m !== null &&
        (!record(m) ||
            !bounded(m.sogKn, 0, 100) ||
            !clock(m.sogAt) ||
            (m.cogTrueDeg !== null && !bounded(m.cogTrueDeg, 0, 359.99999999999994)) ||
            (m.cogAt !== null && !clock(m.cogAt)) ||
            (m.cogTrueDeg === null) !== (m.cogAt === null))
    )
        return null;
    return copyOwnship(value as unknown as RadarOwnship);
}
/** Re-run exactly the original qualification, then age it. No HTTP-provided qualified flag is trusted. */
export function restoreRadarObservation(value: unknown, feedId: string, now: number): RadarContact | null {
    if (
        !record(value) ||
        !clock(value.receivedAt) ||
        !clock(value.evaluatedAt) ||
        !Number.isFinite(now) ||
        value.evaluatedAt > now + 1000 ||
        now - value.evaluatedAt > RADAR_HISTORY_MS ||
        value.receivedAt > value.evaluatedAt + 1000 ||
        value.evaluatedAt - value.receivedAt > 15_000
    )
        return null;
    const ownship = decodeRadarOwnship(value.ownship, feedId);
    if (!ownship) return null;
    const report = parseRadarSentence(value.sentence, { feedId, receivedAt: value.receivedAt, now: value.evaluatedAt });
    return report ? ageRadarContact(qualifyRadarReport(report, ownship, value.evaluatedAt), now) : null;
}
