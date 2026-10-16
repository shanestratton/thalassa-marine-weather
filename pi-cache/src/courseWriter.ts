import { createHash, randomBytes, randomUUID } from 'node:crypto';

type Request = {
    method: 'GET' | 'PUT' | 'DELETE';
    target: 'course' | 'activeRoute' | 'route';
    routeId?: string;
    body?: unknown;
};
export interface CourseWriterTransport {
    requestCourse(request: Request): Promise<unknown>;
}
export interface FollowedCourse {
    key: string;
    name: string;
    points: Array<{ lat: number; lon: number }>;
}
export interface OwnedCourse {
    device: string;
    routeKey: string;
    digest: string;
    resourceId: string;
    startTime: string | null;
    phase: 'activating' | 'active';
}
export interface CourseOwnershipStore {
    read(): OwnedCourse[];
    write(value: OwnedCourse[]): void;
}
type Challenge = {
    token: string;
    device: string;
    route: FollowedCourse;
    digest: string;
    resourceId: string;
    prior: string;
    expiresAt: number;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const text = (value: unknown, maximum: number): value is string =>
    typeof value === 'string' && !!value.trim() && value.length <= maximum && !/\p{Cc}/u.test(value);
function routeCopy(raw: FollowedCourse): FollowedCourse {
    if (
        !raw ||
        !text(raw.key, 200) ||
        !text(raw.name, 80) ||
        !Array.isArray(raw.points) ||
        raw.points.length < 2 ||
        raw.points.length > 1000 ||
        !raw.points.every(
            (p) =>
                p &&
                Number.isFinite(p.lat) &&
                Math.abs(p.lat) <= 90 &&
                Number.isFinite(p.lon) &&
                Math.abs(p.lon) <= 180,
        )
    )
        throw Error('A followed route of 2–1000 valid points is required.');
    return { key: raw.key, name: raw.name, points: raw.points.map((p) => ({ lat: p.lat, lon: p.lon })) };
}
const digestOf = (route: FollowedCourse) => createHash('sha256').update(JSON.stringify(route)).digest('hex');
function course(raw: unknown): {
    activeId: string | null;
    startTime: string | null;
    fingerprint: string;
    hasDestination: boolean;
} {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw Error('The boat’s current course could not be verified.');
    const row = raw as Record<string, unknown>;
    if (!('activeRoute' in row) || !('nextPoint' in row)) throw Error('The boat’s current course is incomplete.');
    const active = row.activeRoute;
    let activeId: string | null = null;
    if (active !== null) {
        if (!active || typeof active !== 'object' || Array.isArray(active)) throw Error('Invalid active course.');
        const href = (active as { href?: unknown }).href;
        if (
            typeof href !== 'string' ||
            !href.startsWith('/resources/routes/') ||
            !UUID.test(href.slice('/resources/routes/'.length))
        )
            throw Error('Unrecognised active route resource.');
        activeId = href.slice('/resources/routes/'.length);
    }
    const startTime = row.startTime === null || row.startTime === undefined ? null : row.startTime;
    if (startTime !== null && (!text(startTime, 64) || !Number.isFinite(Date.parse(startTime))))
        throw Error('Invalid course start time.');
    const fingerprint = createHash('sha256')
        .update(JSON.stringify([startTime, active, row.nextPoint, row.previousPoint ?? null]))
        .digest('hex');
    return { activeId, startTime, fingerprint, hasDestination: active !== null || row.nextPoint !== null };
}

/** Fixed course/resource API only. The app supplies the explicit helm interlock; this module never engages a pilot. */
export function createCourseWriter(options: {
    transport: CourseWriterTransport;
    store: CourseOwnershipStore;
    now?: () => number;
    allowed: (device: string) => boolean;
    pilotEngaged: () => boolean;
}) {
    const now = options.now ?? Date.now;
    const pending = new Map<string, Challenge>();
    let busy = false;
    const claims = () => {
        const rows = options.store.read();
        if (
            !Array.isArray(rows) ||
            rows.length > 8 ||
            !rows.every(
                (row) =>
                    row &&
                    text(row.device, 128) &&
                    text(row.routeKey, 200) &&
                    /^[a-f0-9]{64}$/.test(row.digest) &&
                    UUID.test(row.resourceId) &&
                    ['activating', 'active'].includes(row.phase) &&
                    (row.startTime === null || (text(row.startTime, 64) && Number.isFinite(Date.parse(row.startTime)))),
            )
        )
            throw Error('The saved course ownership needs review.');
        return rows;
    };
    const authority = (device: string) => {
        if (!text(device, 128) || !options.allowed(device))
            throw Error('This device is no longer authorised for the boat.');
    };
    const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
        if (busy) throw Error('Another course operation is in progress.');
        busy = true;
        try {
            return await work();
        } finally {
            busy = false;
        }
    };
    return {
        async preview(device: string, raw: FollowedCourse) {
            authority(device);
            const route = routeCopy(raw),
                digest = digestOf(route);
            const previous = course(await options.transport.requestCourse({ method: 'GET', target: 'course' }));
            authority(device);
            for (const [key, value] of pending) if (value.expiresAt < now()) pending.delete(key);
            if (pending.size >= 8) throw Error('Close an older route confirmation before opening another.');
            const token = randomBytes(16).toString('hex'),
                expiresAt = now() + 30_000;
            pending.set(token, {
                token,
                device,
                route,
                digest,
                prior: previous.fingerprint,
                resourceId: randomUUID(),
                expiresAt,
            });
            return {
                token,
                digest,
                expiresAt,
                pointCount: route.points.length,
                replacesDestination: previous.hasDestination,
            };
        },
        activate(
            device: string,
            intent: { token: string; digest: string; pilotInStandby: boolean; replaceExisting: boolean },
        ) {
            return exclusive(async () => {
                authority(device);
                const choice = pending.get(intent.token);
                if (!choice || choice.device !== device || choice.digest !== intent.digest || now() > choice.expiresAt)
                    throw Error('Review this exact followed route again.');
                if (intent.pilotInStandby !== true || options.pilotEngaged())
                    throw Error('Put the pilot in standby and confirm at the helm.');
                const fresh = () => {
                    authority(device);
                    if (now() > choice.expiresAt) throw Error('The route confirmation expired. Review it again.');
                    if (options.pilotEngaged()) throw Error('The pilot became engaged. Check it at the helm.');
                };
                if (claims().length >= 8) throw Error('Review and clear an earlier unconfirmed course first.');
                pending.delete(intent.token); // no automatic replay of a possibly completed write
                const current = course(await options.transport.requestCourse({ method: 'GET', target: 'course' }));
                authority(device);
                if (current.fingerprint !== choice.prior) throw Error('The boat’s course changed. Review it again.');
                if (current.hasDestination && intent.replaceExisting !== true)
                    throw Error('Confirm replacement of the boat’s current destination.');
                const coordinates = choice.route.points.map((p) => [p.lon, p.lat]);
                fresh();
                await options.transport.requestCourse({
                    method: 'PUT',
                    target: 'route',
                    routeId: choice.resourceId,
                    body: {
                        name: choice.route.name,
                        feature: { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} },
                    },
                });
                authority(device);
                const saved = (await options.transport.requestCourse({
                    method: 'GET',
                    target: 'route',
                    routeId: choice.resourceId,
                })) as { name?: unknown; feature?: { geometry?: { type?: unknown; coordinates?: unknown } } };
                authority(device);
                if (
                    saved?.name !== choice.route.name ||
                    saved.feature?.geometry?.type !== 'LineString' ||
                    JSON.stringify(saved.feature.geometry.coordinates) !== JSON.stringify(coordinates)
                )
                    throw Error('The boat did not retain the exact route geometry.');
                if (options.pilotEngaged())
                    throw Error('The pilot became engaged. The route was saved but not activated.');
                const latest = course(await options.transport.requestCourse({ method: 'GET', target: 'course' }));
                authority(device);
                if (latest.fingerprint !== choice.prior)
                    throw Error('The boat’s course changed while the route was being saved.');
                fresh();
                const owned: OwnedCourse = {
                    device,
                    routeKey: choice.route.key,
                    digest: choice.digest,
                    resourceId: choice.resourceId,
                    startTime: null,
                    phase: 'activating',
                };
                options.store.write([...claims(), owned]); // preserve earlier ownership through an uncertain write
                fresh();
                await options.transport.requestCourse({
                    method: 'PUT',
                    target: 'activeRoute',
                    body: { href: `/resources/routes/${choice.resourceId}` },
                });
                authority(device);
                const confirmed = course(await options.transport.requestCourse({ method: 'GET', target: 'course' }));
                if (confirmed.activeId !== choice.resourceId || !confirmed.startTime)
                    throw Error('Activation is unconfirmed. Check the plotter; do not send again automatically.');
                options.store.write(
                    claims()
                        .filter((row) => row.phase === 'activating' && row.resourceId !== owned.resourceId)
                        .concat({ ...owned, phase: 'active', startTime: confirmed.startTime }),
                );
                return { active: true, digest: choice.digest, resourceId: choice.resourceId };
            });
        },
        clear(device: string, routeKey: string) {
            return exclusive(async () => {
                authority(device);
                const candidates = claims().filter((row) => row.device === device && row.routeKey === routeKey);
                if (!candidates.length) return { cleared: false, reason: 'not-owned' };
                const current = course(await options.transport.requestCourse({ method: 'GET', target: 'course' }));
                authority(device);
                const owned = candidates.find(
                    (row) =>
                        current.activeId === row.resourceId && (!row.startTime || current.startTime === row.startTime),
                );
                if (!owned) {
                    options.store.write(
                        claims().filter(
                            (row) => !candidates.some((candidate) => candidate.resourceId === row.resourceId),
                        ),
                    );
                    return { cleared: false, reason: 'course-changed' };
                }
                await options.transport.requestCourse({ method: 'DELETE', target: 'course' });
                authority(device);
                const after = course(await options.transport.requestCourse({ method: 'GET', target: 'course' }));
                if (after.activeId === owned.resourceId)
                    throw Error('The boat still reports this route. Clear it at the plotter.');
                options.store.write(claims().filter((row) => row.resourceId !== owned.resourceId));
                return { cleared: true, otherDestinationPresent: after.hasDestination };
            });
        },
    };
}
