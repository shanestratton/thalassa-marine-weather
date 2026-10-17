import { supabase, supabaseAnonKey, supabaseUrl } from '../supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from '../authIdentityScope';
import { satelliteModeActive } from '../networkPolicy';
import {
    NOTE_LEASE_MS,
    parseChartNotes,
    validNoteBBox,
    isChartNoteId,
    type ChartNote,
    type ChartNoteBBox,
} from './chartNotesModel';

export const CHART_NOTES_CHANGED = 'thalassa:chart-notes-changed';
let generation = 0;
let reservations = 0;
const listeners = new Set<() => void>();
const networkAvailable = () => !satelliteModeActive() && (typeof navigator === 'undefined' || navigator.onLine);
/** No cache, persisted content, Realtime subscription or background retry. */
export function retireChartNotes() {
    generation++;
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            /* Every remaining lease must still retire. */
        }
    }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHART_NOTES_CHANGED));
}
export async function chartNotesRequest(
    action: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
    if (!supabase || !networkAvailable()) throw Error('Community notes need a normal internet connection.');
    const scope = getAuthIdentityScope();
    const ctl = new AbortController();
    const abort = () => ctl.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) ctl.abort();
    const unsubscribe = subscribeAuthIdentityScope(abort);
    const timer = setTimeout(abort, 10000);
    const mutating = !['list', 'mine', 'owned', 'queue'].includes(action);
    if (mutating) retireChartNotes();
    try {
        const { data, error } = await supabase
            .rpc('community_chart_notes', { p_action: action, p_input: input })
            .abortSignal(ctl.signal);
        if (ctl.signal.aborted || !isAuthIdentityScopeCurrent(scope) || !networkAvailable())
            throw Error('Community note request retired.');
        if (error) throw Error('Community notes unavailable or changed. Refresh and try again.');
        if (data === null) return null;
        if (typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 500000)
            throw Error('Invalid community note response.');
        return data as Record<string, unknown>;
    } finally {
        if (mutating) retireChartNotes();
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', abort);
    }
}
export interface ChartNoteWindow {
    readonly notes: readonly ChartNote[];
    readonly truncated: boolean;
    serverNow(): number;
    isCurrent(): boolean;
    release(): void;
}
/** Full round-trip time is charged against server expiry; local wall clock cannot extend a note. */
export async function readChartNoteWindow(
    bbox: ChartNoteBBox,
    signal?: AbortSignal,
    onRetired?: () => void,
): Promise<ChartNoteWindow> {
    if (!validNoteBBox(bbox)) throw Error('Zoom in for community notes (view must be at most 4° wide and high).');
    if (reservations >= 4) throw Error('Too many community note windows. Close another view.');
    reservations++;
    const scope = getAuthIdentityScope(),
        epoch = generation,
        started = performance.now();
    let parsed: ReturnType<typeof parseChartNotes> | undefined;
    try {
        parsed = parseChartNotes(await chartNotesRequest('list', { bbox: [...bbox] }, signal));
    } catch (error) {
        reservations--;
        throw error;
    }
    const arrived = performance.now(),
        elapsed = Math.max(0, arrived - started);
    const serverClock = parsed.serverNow,
        truncated = parsed.truncated;
    let notes: readonly ChartNote[] = parsed.notes;
    parsed = undefined;
    const remaining = Math.min(
        NOTE_LEASE_MS - elapsed,
        ...notes.map((n) => Date.parse(n.expires_at) - serverClock - elapsed),
    );
    const deadline = arrived + remaining;
    let lastClock = arrived;
    let released = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    let unsubscribe = () => {};
    const release = () => {
        if (released) return;
        released = true;
        reservations--;
        notes = [];
        clearTimeout(timer);
        unsubscribe();
        listeners.delete(release);
        signal?.removeEventListener('abort', release);
        if (typeof window !== 'undefined') window.removeEventListener('offline', release);
        try {
            onRetired?.();
        } catch {
            /* Retirement cannot be undone by a subscriber. */
        }
    };
    const isCurrent = () => {
        const now = performance.now();
        const clockInvalid = !Number.isFinite(now) || now < lastClock;
        lastClock = now;
        if (
            clockInvalid ||
            released ||
            signal?.aborted ||
            generation !== epoch ||
            !isAuthIdentityScopeCurrent(scope) ||
            !networkAvailable() ||
            now >= deadline
        )
            release();
        return !released;
    };
    if (
        remaining <= 0 ||
        epoch !== generation ||
        signal?.aborted ||
        !isAuthIdentityScopeCurrent(scope) ||
        !networkAvailable()
    ) {
        release();
        throw Error('Community note window retired. Refresh to recheck.');
    }
    unsubscribe = subscribeAuthIdentityScope(release);
    listeners.add(release);
    signal?.addEventListener('abort', release, { once: true });
    if (typeof window !== 'undefined') window.addEventListener('offline', release, { once: true });
    timer = setTimeout(release, remaining);
    return Object.freeze({
        get notes() {
            return isCurrent() ? notes : [];
        },
        truncated,
        serverNow: () => serverClock + elapsed + Math.max(0, performance.now() - arrived),
        isCurrent,
        release,
    });
}
export async function chartPhotoRequest(
    id: string,
    signal: AbortSignal,
    upload?: { blob: Blob; revision: string },
): Promise<Response> {
    if (!isChartNoteId(id)) throw Error('Invalid note photo.');
    const scope = getAuthIdentityScope();
    if (!supabase || !networkAvailable() || !scope.userId)
        throw Error('Sign in with a normal internet connection to view photos.');
    const {
        data: { session },
    } = await supabase.auth.getSession();
    if (!session || signal.aborted || !isAuthIdentityScopeCurrent(scope)) throw Error('Photo request retired.');
    const headers: Record<string, string> = {
        Authorization: 'Bearer ' + session.access_token,
        apikey: supabaseAnonKey,
    };
    if (upload)
        Object.assign(headers, { 'Content-Type': 'image/jpeg', 'X-Note-Id': id, 'X-Note-Revision': upload.revision });
    const response = await fetch(
        supabaseUrl + '/functions/v1/community-chart-photo' + (upload ? '' : '?id=' + encodeURIComponent(id)),
        { method: upload ? 'POST' : 'GET', headers, body: upload?.blob, signal, cache: 'no-store' },
    );
    if (!response.ok || signal.aborted || !isAuthIdentityScopeCurrent(scope) || !networkAvailable())
        throw Error('Photo unavailable; it may be pending, reported or removed.');
    return response;
}
