import { decodeRadarOwnship, restoreRadarObservation } from '../../utils/radarFeed';
import type { RadarContact, RadarOwnship } from '../../utils/radarTarget';
import { validRadarOwner, type RadarWatchOwner } from '../../utils/radarWatchContract';
export const RADAR_PI_BYTES = 512 * 1024;
export interface PiRadarPicture {
    owner: RadarWatchOwner;
    configured: boolean;
    connected: boolean;
    overloaded: boolean;
    feedId: string | null;
    servedAt: number;
    lastFrameAt: number | null;
    lastTargetAt: number | null;
    ownship: RadarOwnship | null;
    contacts: RadarContact[];
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const clock = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
/** Paired transport is necessary but never substitutes for source/shape/clock qualification. */
export function decodePiRadarPicture(body: unknown, now: number): PiRadarPicture | null {
    if (!object(body)) return null;
    const servedAt = body.servedAt;
    if (
        body.schema !== 1 ||
        !validRadarOwner(body.owner) ||
        body.source !== 'radar' ||
        !clock(servedAt) ||
        !Number.isFinite(now) ||
        servedAt > now + 1000 ||
        now - servedAt > 15_000 ||
        typeof body.configured !== 'boolean' ||
        typeof body.connected !== 'boolean' ||
        typeof body.overloaded !== 'boolean' ||
        !Array.isArray(body.observations) ||
        body.observations.length > 400 ||
        ![body.lastFrameAt, body.lastTargetAt].every((at) => at === null || (clock(at) && at <= servedAt + 1000))
    )
        return null;
    const { configured, connected, overloaded, owner } = body;
    const lastFrameAt = body.lastFrameAt as number | null,
        lastTargetAt = body.lastTargetAt as number | null;
    if (!connected) {
        if (
            body.feedId !== null ||
            body.ownship !== null ||
            body.observations.length ||
            body.lastFrameAt !== null ||
            body.lastTargetAt !== null
        )
            return null;
        return {
            owner: { ...owner },
            configured,
            connected,
            overloaded,
            servedAt,
            feedId: null,
            ownship: null,
            contacts: [],
            lastFrameAt: null,
            lastTargetAt: null,
        };
    }
    if (!configured || overloaded || typeof body.feedId !== 'string' || !/^pi:[a-f0-9]{32}$/.test(body.feedId))
        return null;
    const ownship = decodeRadarOwnship(body.ownship, body.feedId);
    if (!ownship) return null;
    const contacts: RadarContact[] = [],
        seen = new Set<string>(),
        targets = new Set<string>();
    for (const evidence of body.observations) {
        if (
            !object(evidence) ||
            !clock(evidence.evaluatedAt) ||
            evidence.evaluatedAt > servedAt + 1000 ||
            !clock(evidence.receivedAt) ||
            body.lastTargetAt === null ||
            evidence.receivedAt > (body.lastTargetAt as number)
        )
            return null;
        const contact = restoreRadarObservation(evidence, body.feedId, now);
        if (!contact) return null;
        const key = `${contact.contactKey}:${(evidence.sentence as string).slice(3, 6)}`;
        if (seen.has(key)) return null;
        seen.add(key);
        targets.add(contact.contactKey);
        contacts.push(contact);
    }
    if (targets.size > 200 || (lastTargetAt !== null && (lastFrameAt === null || lastTargetAt > lastFrameAt)))
        return null;
    return {
        owner: { ...owner },
        configured,
        connected,
        overloaded,
        servedAt,
        feedId: body.feedId,
        ownship,
        contacts,
        lastFrameAt: body.lastFrameAt as number | null,
        lastTargetAt: body.lastTargetAt as number | null,
    };
}
