/** Explicit route writes only, over the enrolled pinned lane. No retry or WAN fallback. */
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from './authIdentityScope';
import { getPairing, getChartDevice, pinnedPiRequest } from './PiPairingService';
import { piCache } from './PiCacheService';
import { isPinnedTransportAvailable } from './piTls';
import { useFollowRouteStore, type FollowRouteState } from '../stores/followRouteStore';

type Follow = Pick<FollowRouteState, 'isFollowing' | 'startedAt' | 'voyageId' | 'voyagePlan' | 'routeCoords'>;
type Target = { base: string; pi: string; key: string; pairedAt: number | string; scope: AuthIdentityScope };
export class PiCourseError extends Error {}
export interface CoursePreview {
    name: string;
    pointCount: number;
    replacesDestination: boolean;
    pilotState: 'standby' | 'engaged' | 'unknown';
    expiresAt: number;
    token: string;
    digest: string;
    routeKey: string;
    /** The exact followed state and private boat captured before any await. */
    current: () => boolean;
    target: Target;
}
const MAX_RESPONSE = 8_192;
type Receipt = { pi: string; key: string; routeKey: string };
const RECEIPTS = 'thalassa_course_claims_v1';
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
function identityCurrent(target: Target): boolean {
    const paired = getPairing();
    return (
        isAuthIdentityScopeCurrent(target.scope) &&
        piCache.lanBaseUrlNow() === target.base &&
        paired?.deviceId === target.pi &&
        paired.publicKeySpki === target.key &&
        paired.pairedAt === target.pairedAt
    );
}
function targetFor(scope: AuthIdentityScope): Target | null {
    const paired = getPairing(),
        base = piCache.lanBaseUrlNow();
    return scope.userId && isAuthIdentityScopeCurrent(scope) && paired && base && isPinnedTransportAvailable()
        ? { base, pi: paired.deviceId, key: paired.publicKeySpki, pairedAt: paired.pairedAt, scope }
        : null;
}
async function routeKey(follow: Follow): Promise<string | null> {
    if (
        !follow.isFollowing ||
        !follow.startedAt ||
        follow.startedAt.length > 64 ||
        (follow.voyageId?.length ?? 0) > 128 ||
        follow.routeCoords.length < 2 ||
        follow.routeCoords.length > 1000
    )
        return null;
    try {
        const exact = JSON.stringify([
            follow.startedAt,
            follow.voyageId,
            follow.routeCoords.map((point) => [point.lat, point.lon]),
        ]);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exact));
        return 'follow-v1:' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
        throw new PiCourseError('This phone could not bind the exact route. Nothing was sent.');
    }
}
function receipts(scope: AuthIdentityScope): Receipt[] {
    try {
        const raw = localStorage.getItem(authScopedStorageKey(RECEIPTS, scope));
        if (!raw) return [];
        if (raw.length > 32_768) throw Error();
        const parsed: unknown = JSON.parse(raw);
        if (
            !Array.isArray(parsed) ||
            parsed.length > 8 ||
            !parsed.every(
                (row) =>
                    object(row) &&
                    typeof row.pi === 'string' &&
                    row.pi.length <= 128 &&
                    typeof row.key === 'string' &&
                    row.key.length <= 4096 &&
                    typeof row.routeKey === 'string' &&
                    row.routeKey.length <= 200,
            )
        )
            throw Error();
        return parsed as Receipt[];
    } catch {
        throw new PiCourseError('The saved plotter handoff needs review before sending another route.');
    }
}
function remember(preview: CoursePreview): void {
    const rows = receipts(preview.target.scope).filter(
        (r) => r.pi !== preview.target.pi || r.key !== preview.target.key || r.routeKey !== preview.routeKey,
    );
    if (rows.length >= 8) throw new PiCourseError('Review an earlier unconfirmed plotter handoff first.');
    rows.push({ pi: preview.target.pi, key: preview.target.key, routeKey: preview.routeKey });
    const encoded = JSON.stringify(rows);
    if (encoded.length > 32_768)
        throw new PiCourseError('The saved handoff receipt is full. Review an earlier send first.');
    try {
        localStorage.setItem(authScopedStorageKey(RECEIPTS, preview.target.scope), encoded);
    } catch {
        throw new PiCourseError('This phone could not keep the handoff receipt. No route was sent.');
    }
}
function sameFollow(previous: Follow): boolean {
    const current = useFollowRouteStore.getState();
    return (
        current.isFollowing &&
        current.startedAt === previous.startedAt &&
        current.voyageId === previous.voyageId &&
        JSON.stringify(current.routeCoords) === JSON.stringify(previous.routeCoords) &&
        current.voyagePlan?.origin === previous.voyagePlan?.origin &&
        current.voyagePlan?.destination === previous.voyagePlan?.destination
    );
}
async function request(
    target: Target,
    action: 'preview' | 'activate' | 'clear',
    data: unknown,
    current: () => boolean = () => identityCurrent(target),
) {
    if (!current()) throw new PiCourseError('The boat or followed route changed. Review it again.');
    const reply = await pinnedPiRequest({
        url: `${target.base}/api/course/${action}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data,
        connectTimeout: 2_000,
        readTimeout: action === 'preview' ? 25_000 : 60_000,
        isCurrent: current,
    });
    if (!identityCurrent(target)) throw new PiCourseError('The paired boat or account changed.');
    const encoded = typeof reply.data === 'string' ? reply.data : JSON.stringify(reply.data);
    if (!encoded || new TextEncoder().encode(encoded).length > MAX_RESPONSE)
        throw new PiCourseError('The boat returned an invalid confirmation.');
    let body: unknown;
    try {
        body = JSON.parse(encoded);
    } catch {
        throw new PiCourseError('The boat returned an invalid confirmation.');
    }
    if (!object(body)) throw new PiCourseError('The boat returned an invalid confirmation.');
    if (reply.status !== 200) {
        if (reply.status === 404) throw new PiCourseError('Pi update 6 is needed to send routes.');
        const error =
            typeof body.error === 'string' && body.error.length <= 240
                ? body.error
                : 'The boat could not confirm this operation. Check the plotter.';
        throw new PiCourseError(error);
    }
    if (body.schema !== 1) throw new PiCourseError('The boat returned an invalid confirmation.');
    return body;
}

export async function previewFollowedCourse(): Promise<CoursePreview> {
    const scope = getAuthIdentityScope(),
        target = targetFor(scope);
    const state = useFollowRouteStore.getState();
    const follow: Follow = { ...state, routeCoords: state.routeCoords.map((p) => ({ ...p })) };
    const key = await routeKey(follow);
    if (!target) throw new PiCourseError('Connect this enrolled phone to the boat’s Pi on her own Wi-Fi.');
    if (
        !key ||
        !follow.voyagePlan ||
        follow.routeCoords.length < 2 ||
        follow.routeCoords.length > 1000 ||
        !follow.routeCoords.every(
            (p) => Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180,
        )
    )
        throw new PiCourseError('Follow a route of 2–1000 valid points. Its geometry will be sent unchanged.');
    const current = () => identityCurrent(target) && sameFollow(follow);
    const device = await getChartDevice();
    if (!device || !current()) throw new PiCourseError('Set up this phone with the code from the boat’s Pi.');
    const name = `${follow.voyagePlan.origin} → ${follow.voyagePlan.destination}`.replace(/\p{Cc}/gu, '').slice(0, 80);
    const route = { key, name, points: follow.routeCoords };
    if (new TextEncoder().encode(JSON.stringify({ route })).length > 32_000)
        throw new PiCourseError('This exact route is too large for the plotter handoff. No points were removed.');
    const body = await request(target, 'preview', { route }, current);
    if (!current()) throw new PiCourseError('The followed route changed. Review it again.');
    if (
        typeof body.token !== 'string' ||
        !/^[a-f0-9]{32}$/.test(body.token) ||
        typeof body.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(body.digest) ||
        body.pointCount !== route.points.length ||
        typeof body.replacesDestination !== 'boolean' ||
        !['standby', 'engaged', 'unknown'].includes(String(body.pilotState)) ||
        typeof body.expiresAt !== 'number' ||
        !Number.isFinite(body.expiresAt) ||
        body.expiresAt < Date.now() ||
        body.expiresAt > Date.now() + 31_000
    )
        throw new PiCourseError('The boat returned an invalid or expired route confirmation.');
    return {
        name,
        pointCount: route.points.length,
        token: body.token,
        digest: body.digest,
        replacesDestination: body.replacesDestination,
        pilotState: body.pilotState as CoursePreview['pilotState'],
        expiresAt: body.expiresAt,
        routeKey: key,
        current,
        target,
    };
}

export async function activateFollowedCourse(
    preview: CoursePreview,
    pilotInStandby: boolean,
    replaceExisting: boolean,
) {
    if (!pilotInStandby || preview.pilotState === 'engaged' || Date.now() > preview.expiresAt || !preview.current())
        throw new PiCourseError('Confirm the current route at the helm with the pilot in standby.');
    remember(preview); // retain an uncertain send across a WebContent kill or app restart
    const body = await request(
        preview.target,
        'activate',
        { token: preview.token, digest: preview.digest, pilotInStandby, replaceExisting },
        preview.current,
    );
    if (!preview.current()) throw new PiCourseError('Follow stopped or changed during the send. Check the plotter.');
    if (
        body.active !== true ||
        body.digest !== preview.digest ||
        typeof body.resourceId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.resourceId)
    )
        throw new PiCourseError('The plotter route is unconfirmed. Check it before sending again.');
}

const clearing = new Map<string, Promise<void>>();
/** Called on every follow replacement/unfollow, including after a cold start.
 * The Pi matches its durable ownership; a route this phone never sent is a no-op. */
export async function clearUnfollowedCourse(follow: Follow, scope: AuthIdentityScope): Promise<void> {
    const key = await routeKey(follow),
        target = targetFor(scope);
    if (!key || !isAuthIdentityScopeCurrent(scope)) return;
    const rows = receipts(scope);
    if (!rows.some((r) => r.routeKey === key)) return;
    if (!target || !rows.some((r) => r.routeKey === key && r.pi === target.pi && r.key === target.key))
        throw new PiCourseError('Follow stopped. The plotter clear is unconfirmed; check it at the helm.');
    await clearReceipt(key, scope, target);
}
/** Explicit recovery action at the helm; never sends or reactivates a route. */
export async function clearSavedCourseReceipts(): Promise<number> {
    const scope = getAuthIdentityScope(),
        target = targetFor(scope);
    if (!target) throw new PiCourseError('Connect this phone to the paired boat’s own Wi-Fi to clear sent routes.');
    const rows = receipts(scope).filter((r) => r.pi === target.pi && r.key === target.key);
    for (const row of rows) await clearReceipt(row.routeKey, scope, target);
    return rows.length;
}
async function clearReceipt(key: string, scope: AuthIdentityScope, target: Target): Promise<void> {
    const operation = JSON.stringify([scope.key, scope.generation, target.pi, target.key, target.base, key]);
    const existing = clearing.get(operation);
    if (existing) return existing;
    if (clearing.size >= 8) throw new PiCourseError('The plotter clear is unconfirmed; check it at the helm.');
    const work = (async () => {
        const device = await getChartDevice();
        if (!identityCurrent(target)) return;
        if (!device)
            throw new PiCourseError('The plotter clear needs this phone’s Pi enrollment. Check it at the helm.');
        const body = await request(target, 'clear', { routeKey: key });
        if (
            body.cleared !== true &&
            !(body.cleared === false && ['not-owned', 'course-changed'].includes(String(body.reason)))
        )
            throw new PiCourseError('The plotter clear is unconfirmed; check it at the helm.');
        if (identityCurrent(target))
            localStorage.setItem(
                authScopedStorageKey(RECEIPTS, scope),
                JSON.stringify(
                    receipts(scope).filter((r) => r.routeKey !== key || r.pi !== target.pi || r.key !== target.key),
                ),
            );
    })();
    clearing.set(operation, work);
    try {
        await work;
    } finally {
        clearing.delete(operation);
    }
}
