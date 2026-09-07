/**
 * remotePassage — what THIS device should know about a passage the account is
 * already running on ANOTHER device.
 *
 * Shane 2026-09-08: "if you connect to supabase from another device, and you
 * already have a route in the log page, can we make it so that it shows in the
 * new device. otherwise they can overwrite it." The second phone used to open
 * to an empty Log page: the active voyage lives on the server, but nothing on
 * the page asked for it unless this device was the one tracking.
 *
 * The truth is two server rows: the account's ACTIVE voyage (stamped with the
 * device that cast off — migration 20260908150000) and its followed-route link
 * (stamped with the device that set it). This module reads both, decides
 * whether they describe a passage this device is NOT recording, and caches the
 * answer so the card paints offline.
 *
 * Advisory, like everything around Cast Off: this tells the skipper who is
 * recording and whose route stands. It never blocks a device from joining the
 * recording or from changing the route — the confirm that names the other
 * device does that work, once, at the moment of the change.
 */
import { getActiveVoyage, type Voyage } from '../VoyageService';
import { VoyageLogService, type PlanLinkRow } from '../VoyageLogService';
import { getDeviceId } from '../skipperDevice';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('remotePassage');

const CACHE_KEY = 'thalassa_remote_passage_cache_v1';

export interface RemotePassage {
    voyageId: string;
    voyageName: string;
    departurePort: string | null;
    destinationPort: string | null;
    departureTime: string | null;
    savedRouteId: string | null;
    /** The device recording the Ship's Log, as it named itself; null on rows older than the stamp. */
    recordingDeviceName: string | null;
    recordingDeviceId: string | null;
    /** The published route link on this voyage, if any. */
    link: PlanLinkRow | null;
    /** True when another device wrote the link (unstamped rows read as nobody's). */
    linkHeldElsewhere: boolean;
    /** ISO time this description was fetched. */
    fetchedAt: string;
}

type RemoteVoyageFields = Pick<
    Voyage,
    | 'id'
    | 'voyage_name'
    | 'status'
    | 'departure_port'
    | 'destination_port'
    | 'departure_time'
    | 'saved_route_id'
    | 'recording_device_id'
    | 'recording_device_name'
>;

/**
 * Pure: the server rows → what to tell this device, or null when there is
 * nothing remote about the passage (no active voyage, this device records it,
 * or this device cast it off and simply is not tracking right now — the
 * cast-off handoff owns that recovery).
 */
export function describeRemotePassage(input: {
    voyage: RemoteVoyageFields | null;
    link: PlanLinkRow | null;
    myDeviceId: string;
    trackingVoyageId: string | null;
    now: number;
}): RemotePassage | null {
    const { voyage, link, myDeviceId, trackingVoyageId } = input;
    if (!voyage || voyage.status !== 'active') return null;
    if (trackingVoyageId === voyage.id) return null;
    const recordingDeviceId = voyage.recording_device_id ?? null;
    if (recordingDeviceId && recordingDeviceId === myDeviceId) return null;
    const linkRow = link && link.voyageId === voyage.id ? link : null;
    return {
        voyageId: voyage.id,
        voyageName: voyage.voyage_name,
        departurePort: voyage.departure_port ?? null,
        destinationPort: voyage.destination_port ?? null,
        departureTime: voyage.departure_time ?? null,
        savedRouteId: voyage.saved_route_id ?? null,
        recordingDeviceName: voyage.recording_device_name ?? null,
        recordingDeviceId,
        link: linkRow,
        linkHeldElsewhere: !!linkRow?.deviceId && linkRow.deviceId !== myDeviceId,
        fetchedAt: new Date(input.now).toISOString(),
    };
}

export type RemotePassageFetch = { ok: true; passage: RemotePassage | null } | { ok: false; reason: string };

/** Ask the server. Caches the answer (including "nothing remote") per account. */
export async function fetchRemotePassage(trackingVoyageId: string | null): Promise<RemotePassageFetch> {
    const scope = getAuthIdentityScope();
    if (!scope.userId) return { ok: false, reason: 'Not signed in.' };
    try {
        const voyage = await getActiveVoyage();
        if (!isAuthIdentityScopeCurrent(scope)) return { ok: false, reason: 'Account changed.' };
        let link: PlanLinkRow | null = null;
        if (voyage && voyage.status === 'active') {
            const read = await VoyageLogService.getPlanLink(voyage.id);
            if (!isAuthIdentityScopeCurrent(scope)) return { ok: false, reason: 'Account changed.' };
            if (!read.ok) return { ok: false, reason: read.reason };
            link = read.row;
        }
        const passage = describeRemotePassage({
            voyage,
            link,
            myDeviceId: getDeviceId(),
            trackingVoyageId,
            now: Date.now(),
        });
        writeRemotePassageCache(passage, scope);
        return { ok: true, passage };
    } catch (error) {
        if (isAuthIdentityScopeCurrent(scope)) log.warn('remote passage read failed:', error);
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

function writeRemotePassageCache(passage: RemotePassage | null, scope: AuthIdentityScope): void {
    try {
        const key = authScopedStorageKey(CACHE_KEY, scope);
        if (passage) localStorage.setItem(key, JSON.stringify(passage));
        else localStorage.removeItem(key);
    } catch {
        /* storage unavailable — the live read still paints */
    }
}

/** The last answer for the CURRENT account, for the first paint and offline. */
export function readRemotePassageCache(): RemotePassage | null {
    try {
        const raw = localStorage.getItem(authScopedStorageKey(CACHE_KEY));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as RemotePassage;
        return parsed && typeof parsed === 'object' && typeof parsed.voyageId === 'string' ? parsed : null;
    } catch {
        return null;
    }
}

/** "since 09:14" today, "since Mon 09:14" otherwise, '' when unknown. */
export function remotePassageSinceLabel(departureTime: string | null, now = Date.now()): string {
    if (!departureTime) return '';
    const ms = Date.parse(departureTime);
    if (!Number.isFinite(ms)) return '';
    const departed = new Date(ms);
    const today = new Date(now);
    const sameDay =
        departed.getFullYear() === today.getFullYear() &&
        departed.getMonth() === today.getMonth() &&
        departed.getDate() === today.getDate();
    const time = departed.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (sameDay) return `since ${time}`;
    return `since ${departed.toLocaleDateString('en-AU', { weekday: 'short' })} ${time}`;
}
