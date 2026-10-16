/** Read-only radar target policy shared verbatim with the Pi. No sockets, clocks or persistence. */
export const RADAR_REPORT_MAX_AGE_MS = 15_000;
export const RADAR_DEPENDENCY_SKEW_MS = 6_000;
export const RADAR_TARGET_CAP = 200;
const DAY = 86_400_000;
const RAD = Math.PI / 180;
const EARTH_NM = 3440.065;
export type RadarStatus = 'tracking' | 'acquiring' | 'lost';
export interface RadarMotion {
    speedKn: number | null;
    courseDeg: number | null;
    reference: 'relative' | 'true' | null;
}
export interface RadarReport {
    source: 'radar';
    feedId: string;
    contactKey: string;
    talker: string;
    targetNumber: number;
    name: string;
    sentence: 'TTM' | 'TLL';
    status: RadarStatus;
    referenceTarget: boolean;
    acquisition: 'automatic' | 'manual' | 'reported' | null;
    /** Original raw ingress time, retained across every later poll. */
    receivedAt: number;
    at: number;
    clock: 'observation-utc' | 'ingress';
    position: { lat: number; lon: number } | null;
    polarPosition: { rangeNm: number; bearingDeg: number; reference: 'true' | 'relative' } | null;
    motion: RadarMotion;
}
export interface RadarOwnship {
    /** The qualified vessel/input identity; another boat's navigation cannot locate this echo. */
    feedId: string;
    position: { lat: number; lon: number; at: number } | null;
    heading: { trueDeg: number; at: number } | null;
    motion: { sogKn: number; sogAt: number; cogTrueDeg: number | null; cogAt: number | null } | null;
}
export interface RadarContact {
    source: 'radar';
    contactKey: string;
    feedId: string;
    talker: string;
    targetNumber: number;
    name: string;
    status: RadarStatus;
    referenceTarget: boolean;
    at: number;
    receivedAt: number;
    clock: RadarReport['clock'];
    position: { lat: number; lon: number } | null;
    /** Ground motion only. Ambiguous true/water-stabilized reports remain unknown. */
    motion: { sogKn: number; cogTrueDeg: number | null; at: number } | null;
    motionReason:
        | 'relative-vector'
        | 'motion-unknown'
        | 'true-reference-unknown'
        | 'dependencies-stale'
        | 'not-tracking';
    /** Earliest original leaf needed to produce the current ground-motion solution. */
    qualifiedAt: number | null;
    fresh: boolean;
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const between = (n: number | null, min: number, max: number): n is number =>
    n !== null && Number.isFinite(n) && n >= min && n <= max;
const number = (s: string | undefined): number | null =>
    s && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s) && Number.isFinite(Number(s)) ? Number(s) : null;
const bearing = (n: number | null): number | null => (between(n, 0, 360) ? n % 360 : null);
const position = (lat: number, lon: number): boolean =>
    finite(lat) && finite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const wrap = (n: number): number => ((n + 540) % 360) - 180;
const recent = (at: number, now: number): boolean =>
    Number.isSafeInteger(at) && at > 0 && at <= now + 1000 && now - at <= RADAR_REPORT_MAX_AGE_MS;
const dependent = (at: number, observationAt: number, now: number): boolean =>
    recent(at, now) && Math.abs(at - observationAt) <= RADAR_DEPENDENCY_SKEW_MS;

export function validRadarFeedId(value: unknown): value is string {
    // The controller derives this opaque identifier from the approved input/vessel/session.
    // This restricted alphabet makes the family/talker/number contact key unambiguous and <=112 chars.
    return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,96}$/.test(value);
}
export function radarContactKey(feedId: string, talker: string, targetNumber: number): string | null {
    return validRadarFeedId(feedId) &&
        /^[A-Z0-9]{2}$/.test(talker) &&
        Number.isInteger(targetNumber) &&
        targetNumber >= 0 &&
        targetNumber <= 999
        ? `radar:${feedId}:${talker}:${targetNumber}`
        : null;
}
function coordinate(raw: string, hemisphere: string, latitude: boolean): number | null {
    if (!(latitude ? /^\d{4}(?:\.\d+)?$/ : /^\d{5}(?:\.\d+)?$/).test(raw)) return null;
    if (!(latitude ? ['N', 'S'] : ['E', 'W']).includes(hemisphere)) return null;
    const v = Number(raw),
        degrees = Math.floor(v / 100),
        minutes = v - degrees * 100;
    const result = degrees + minutes / 60;
    return minutes < 60 && result <= (latitude ? 90 : 180)
        ? (hemisphere === 'S' || hemisphere === 'W' ? -1 : 1) * result
        : null;
}
export function radarObservationTime(
    raw: string | undefined,
    receivedAt: number,
): { at: number; clock: RadarReport['clock'] } | null {
    if (!raw) return { at: receivedAt, clock: 'ingress' };
    if (!/^\d{6}(?:\.\d{1,6})?$/.test(raw)) return null;
    const hour = Number(raw.slice(0, 2)),
        minute = Number(raw.slice(2, 4)),
        second = Number(raw.slice(4));
    if (hour > 23 || minute > 59 || second >= 60) return null;
    const withinDay = Math.trunc((hour * 3600 + minute * 60 + second) * 1000);
    const dayStart = Math.floor(receivedAt / DAY) * DAY;
    const candidates = [-DAY, 0, DAY].map((offset) => dayStart + offset + withinDay);
    const at = candidates.sort((a, b) => Math.abs(a - receivedAt) - Math.abs(b - receivedAt))[0];
    return at <= receivedAt + 1000 && receivedAt - at <= RADAR_REPORT_MAX_AGE_MS
        ? { at, clock: 'observation-utc' }
        : null;
}

/** Strict TTM/TLL framing. Radar never inherits checksum-absent instrument compatibility. */
export function parseRadarSentence(
    sentence: unknown,
    context: { feedId: string; receivedAt: number; now: number },
): RadarReport | null {
    if (!validRadarFeedId(context.feedId) || !finite(context.now) || !recent(context.receivedAt, context.now))
        return null;
    if (
        typeof sentence !== 'string' ||
        sentence.length > 256 ||
        !/^\$[A-Z0-9]{2}(?:TTM|TLL),[\x20-\x7e]*\*[0-9a-fA-F]{2}$/.test(sentence)
    )
        return null;
    const star = sentence.indexOf('*');
    if (star !== sentence.length - 3) return null;
    let checksum = 0;
    for (let i = 1; i < star; i++) checksum ^= sentence.charCodeAt(i);
    if (checksum !== Number.parseInt(sentence.slice(star + 1), 16)) return null;
    const fields = sentence.slice(0, star).split(',');
    const type = fields[0].slice(3) as 'TTM' | 'TLL';
    if (!/^\d{1,3}$/.test(fields[1])) return null;
    const targetNumber = Number(fields[1]),
        talker = fields[0].slice(1, 3);
    const contactKey = radarContactKey(context.feedId, talker, targetNumber);
    if (!contactKey) return null;
    const isTtm = type === 'TTM';
    if (fields.length < (isTtm ? 14 : 10) || fields.length > (isTtm ? 16 : 10)) return null;
    const statusRaw = fields[isTtm ? 12 : 8],
        referenceRaw = fields[isTtm ? 13 : 9];
    const status = ({ T: 'tracking', Q: 'acquiring', L: 'lost' } as const)[statusRaw as 'T' | 'Q' | 'L'];
    if (!status || (referenceRaw !== '' && referenceRaw !== 'R')) return null;
    const time = radarObservationTime(fields[isTtm ? 14 : 7], context.receivedAt);
    if (!time) return null;
    const acquisitionRaw = isTtm ? (fields[15] ?? '') : '';
    if (!['', 'A', 'M', 'R'].includes(acquisitionRaw)) return null;
    const result: RadarReport = {
        source: 'radar',
        feedId: context.feedId,
        contactKey,
        talker,
        targetNumber,
        name: fields[isTtm ? 11 : 6].trim().slice(0, 80),
        sentence: type,
        status,
        referenceTarget: referenceRaw === 'R',
        acquisition:
            ({ A: 'automatic', M: 'manual', R: 'reported' } as const)[acquisitionRaw as 'A' | 'M' | 'R'] ?? null,
        receivedAt: context.receivedAt,
        ...time,
        position: null,
        polarPosition: null,
        motion: { speedKn: null, courseDeg: null, reference: null },
    };
    if (isTtm) {
        const declaredScale = ({ N: 1, K: 1 / 1.852, S: 1609.344 / 1852 } as const)[fields[10] as 'N' | 'K' | 'S'];
        if (
            !declaredScale &&
            (status === 'tracking' || fields[10] !== '' || [2, 3, 5, 6, 8, 9].some((index) => fields[index] !== ''))
        )
            return null;
        // No numeric measurement is used when units are absent on a lost/acquiring report.
        const scale = declaredScale ?? 1;
        const range = number(fields[2]),
            angle = bearing(number(fields[3]));
        if (!['', 'T', 'R'].includes(fields[4]) || (range !== null && fields[4] === '')) return null;
        if (between(range, 0, 100) && angle !== null)
            result.polarPosition = {
                rangeNm: range * scale,
                bearingDeg: angle,
                reference: fields[4] === 'T' ? 'true' : 'relative',
            };
        else if (status === 'tracking' || fields[2] !== '' || fields[3] !== '') return null;
        const speed = number(fields[5]),
            course = bearing(number(fields[6]));
        if (fields[5] !== '' && !between(speed, 0, 200 / scale)) return null;
        if (fields[6] !== '' && course === null) return null;
        if (!['', 'T', 'R'].includes(fields[7])) return null;
        if ((fields[5] !== '' || fields[6] !== '') && fields[7] === '') return null;
        result.motion = {
            speedKn: speed === null ? null : speed * scale,
            courseDeg: course,
            reference: fields[7] === 'T' ? 'true' : fields[7] === 'R' ? 'relative' : null,
        };
        // CPA/TCPA are the radar's own result. They are intentionally not substituted for the shared collision rule.
        if (fields[8] !== '' && !between(number(fields[8]), 0, 100)) return null;
        if (fields[9] !== '' && !between(number(fields[9]), -999, 999)) return null;
    } else {
        const lat = coordinate(fields[2], fields[3], true),
            lon = coordinate(fields[4], fields[5], false);
        if (lat !== null && lon !== null) result.position = { lat, lon };
        else if (status === 'tracking' || fields.slice(2, 6).some((field) => field !== '')) return null;
    }
    return result;
}

function destination(lat: number, lon: number, angle: number, rangeNm: number): { lat: number; lon: number } {
    const phi = lat * RAD,
        course = angle * RAD,
        distance = rangeNm / EARTH_NM;
    const nextLat = Math.asin(
        Math.sin(phi) * Math.cos(distance) + Math.cos(phi) * Math.sin(distance) * Math.cos(course),
    );
    const nextLon =
        lon * RAD +
        Math.atan2(
            Math.sin(course) * Math.sin(distance) * Math.cos(phi),
            Math.cos(distance) - Math.sin(phi) * Math.sin(nextLat),
        );
    return { lat: nextLat / RAD, lon: wrap(nextLon / RAD) };
}
/** Re-evaluate the raw report against original ownship clocks. Polling never refreshes either. */
export function qualifyRadarReport(report: RadarReport, own: RadarOwnship | null, now: number): RadarContact {
    const fresh = finite(now) && recent(report.at, now) && recent(report.receivedAt, now);
    const contact: RadarContact = {
        source: 'radar',
        contactKey: report.contactKey,
        feedId: report.feedId,
        talker: report.talker,
        targetNumber: report.targetNumber,
        name: report.name,
        status: report.status,
        referenceTarget: report.referenceTarget,
        at: report.at,
        receivedAt: report.receivedAt,
        clock: report.clock,
        position: report.position,
        motion: null,
        motionReason: 'motion-unknown',
        qualifiedAt: null,
        fresh,
    };
    const sameFeed = own?.feedId === report.feedId;
    const fix = sameFeed ? own?.position : null,
        heading = sameFeed ? own?.heading : null;
    const headingOkay = !!heading && bearing(heading.trueDeg) !== null && dependent(heading.at, report.at, now);
    const usedClocks = [report.at];
    if (report.polarPosition) {
        const polar = report.polarPosition;
        if (
            !fix ||
            !position(fix.lat, fix.lon) ||
            !dependent(fix.at, report.at, now) ||
            (polar.reference === 'relative' && !headingOkay)
        ) {
            contact.position = null;
            contact.motionReason = 'dependencies-stale';
            return contact;
        }
        contact.position = destination(
            fix.lat,
            fix.lon,
            polar.bearingDeg + (polar.reference === 'relative' ? heading!.trueDeg : 0),
            polar.rangeNm,
        );
        usedClocks.push(fix.at);
        if (polar.reference === 'relative') usedClocks.push(heading!.at);
    }
    if (report.status !== 'tracking' || report.referenceTarget) {
        contact.motionReason = 'not-tracking';
        return contact;
    }
    if (!fresh) {
        contact.motionReason = 'dependencies-stale';
        return contact;
    }
    const motion = report.motion;
    if (motion.reference === 'true') {
        // T means true-course orientation; it does not prove ground rather than water stabilization.
        contact.motionReason = 'true-reference-unknown';
        return contact;
    }
    if (motion.reference !== 'relative' || motion.speedKn === null || (motion.speedKn > 0 && motion.courseDeg === null))
        return contact;
    const ownMotion = sameFeed ? own?.motion : null;
    if (
        !ownMotion ||
        (motion.speedKn > 0 && !headingOkay) ||
        !between(ownMotion.sogKn, 0, 100) ||
        !dependent(ownMotion.sogAt, report.at, now) ||
        (ownMotion.sogKn > 0 &&
            (bearing(ownMotion.cogTrueDeg) === null ||
                ownMotion.cogAt === null ||
                !dependent(ownMotion.cogAt, report.at, now)))
    ) {
        contact.motionReason = 'dependencies-stale';
        return contact;
    }
    const relativeAngle = ((motion.courseDeg ?? 0) + (heading?.trueDeg ?? 0)) * RAD;
    const ownAngle = (ownMotion.cogTrueDeg ?? 0) * RAD;
    const east = motion.speedKn * Math.sin(relativeAngle) + ownMotion.sogKn * Math.sin(ownAngle);
    const north = motion.speedKn * Math.cos(relativeAngle) + ownMotion.sogKn * Math.cos(ownAngle);
    const sogKn = Math.hypot(east, north);
    if (sogKn > 200) return contact;
    usedClocks.push(ownMotion.sogAt);
    if (motion.speedKn > 0) usedClocks.push(heading!.at);
    if (ownMotion.sogKn > 0) usedClocks.push(ownMotion.cogAt!);
    contact.qualifiedAt = Math.min(...usedClocks);
    contact.motion = {
        sogKn,
        cogTrueDeg: sogKn < 1e-9 ? null : (Math.atan2(east, north) / RAD + 360) % 360,
        at: contact.qualifiedAt,
    };
    contact.motionReason = 'relative-vector';
    return contact;
}
