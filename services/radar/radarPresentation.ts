/** Private presentation adapter; never rewrites either sensor's retained evidence. */
import { matchRadarToAis, type RadarAisMatchEvidence } from '../../utils/radarAisMatch';
import { gradeRadarContact, worstRadarCandidates, type RadarCollisionCandidate } from '../../utils/radarCollision';
import {
    rangeBearing,
    type CollisionAssessment,
    type CollisionPrefs,
    DEFAULT_COLLISION_PREFS,
} from '../../utils/collisionRule';
import type { RadarContact } from '../../utils/radarTarget';
import type { RadarPictureSnapshot } from './radarStore';
export interface RadarDisplayRow {
    contact: RadarContact;
    grade: RadarCollisionCandidate | null;
    assessment: CollisionAssessment | null;
    ais: GeoJSON.Feature<GeoJSON.Point> | null;
    name: string;
    rangeNm: number | null;
    bearingDeg: number | null;
}
export function radarAisEvidence(features: readonly GeoJSON.Feature[]): RadarAisMatchEvidence[] {
    return features.flatMap((f) => {
        const p = f.properties;
        if (
            !p ||
            f.geometry?.type !== 'Point' ||
            (p.source !== 'local' && p.source !== 'cloud') ||
            p.informational === true
        )
            return [];
        const raw = p.updatedAt ?? p.lastUpdated,
            at = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN;
        const [lon, lat] = f.geometry.coordinates;
        return [
            {
                mmsi: Number(p.mmsi),
                lat,
                lon,
                sogKn: typeof p.sog === 'number' ? p.sog : null,
                cogDeg: typeof p.cog === 'number' ? p.cog : null,
                at,
                source: p.source,
            },
        ];
    });
}
const rank = (a: CollisionAssessment | null) =>
    !a ? 0 : a.closeQuarters ? 5 : a.risk === 'DANGER' ? 4 : a.risk === 'CAUTION' ? 3 : a.rangeOnly ? 2 : 1;
export function radarDisplayRows(
    snapshot: RadarPictureSnapshot,
    features: readonly GeoJSON.Feature<GeoJSON.Point>[],
    now: number,
    prefs: CollisionPrefs = DEFAULT_COLLISION_PREFS,
    atAnchor = false,
    aisAssessments: ReadonlyMap<number, CollisionAssessment> = new Map(),
): RadarDisplayRow[] {
    const own = new Map(snapshot.feeds.map((f) => [f.feedId, f.ownship]));
    const grades = worstRadarCandidates(
        snapshot.contacts.flatMap((c) => {
            const result = gradeRadarContact(c, own.get(c.feedId) ?? null, now, prefs, atAnchor);
            return result ? [result] : [];
        }),
    );
    const byKey = new Map(grades.map((c) => [c.contactKey, c]));
    const contacts = new Map<string, RadarContact>();
    for (const c of snapshot.contacts) {
        const previous = contacts.get(c.contactKey);
        if (!previous || c.at > previous.at) contacts.set(c.contactKey, c);
    }
    const matches = matchRadarToAis(snapshot.contacts, radarAisEvidence(features), now);
    const ais = new Map(features.map((f) => [Number(f.properties?.mmsi), f]));
    return [...contacts].flatMap(([key, latest]) => {
        const grade = byKey.get(key) ?? null,
            contact = grade?.contact ?? latest;
        if (!contact.position) return [];
        const mmsi = matches.get(key),
            paired = mmsi === undefined ? null : (ais.get(mmsi) ?? null);
        const a = mmsi === undefined ? null : (aisAssessments.get(mmsi) ?? null);
        const assessment = rank(a) > rank(grade?.assessment ?? null) ? a : (grade?.assessment ?? null);
        const position = own.get(contact.feedId)?.position;
        const range =
            position && position.at <= now + 1000 && now - position.at <= 15000
                ? rangeBearing(position.lat, position.lon, contact.position.lat, contact.position.lon)
                : null;
        const reported = paired?.properties?.name;
        const name =
            typeof reported === 'string' && reported.trim()
                ? reported.slice(0, 80)
                : contact.name || `Radar ${contact.targetNumber}`;
        return [
            {
                contact,
                grade,
                assessment,
                ais: paired,
                name,
                rangeNm: range?.rangeNm ?? null,
                bearingDeg: range?.bearingDeg ?? null,
            },
        ];
    });
}
