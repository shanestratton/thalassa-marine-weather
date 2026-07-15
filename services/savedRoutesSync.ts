/**
 * Saved-route account sync — build on the desktop, sail on the phone
 * (masterplan Phase 5.3, table `saved_routes`).
 *
 * localStorage stays the source of truth for the UI (offline-first, exactly
 * like the diary): saves and deletes land locally first and push to the
 * account best-effort; `syncSavedRoutes()` pull-merges the account set when
 * the tracer opens. Merge is by id with newest-stamp-wins per id — same-name
 * saves OVERWRITE in place since 2026-07-15 (same id, fresh updatedAt), so
 * an offline overwrite must beat the stale account copy, not revert to it.
 */
import { supabase, isSupabaseConfigured } from './supabase';
import { loadSavedTraces, type SavedTrace, type TracePoint } from './routeTracer';
import { createLogger } from '../utils/createLogger';

const log = createLogger('savedRoutesSync');

const TRACES_KEY = 'thalassa_traced_routes_v1';

function writeLocal(all: SavedTrace[]): void {
    try {
        localStorage.setItem(TRACES_KEY, JSON.stringify(all.slice(0, 50)));
    } catch {
        /* quota — local set unchanged */
    }
}

async function signedIn(): Promise<boolean> {
    if (!isSupabaseConfigured() || !supabase) return false;
    try {
        return !!(await supabase.auth.getUser()).data.user;
    } catch {
        return false;
    }
}

/** Outcome of a push — surfaced in the tracer's save flash so a route
 *  that only landed on THIS device never silently poses as synced. */
export type PushResult = 'ok' | 'signedout' | 'toolarge' | 'error';

/** Push one trace to the account. Fire-and-forget from saveTrace. */
export async function pushSavedRoute(trace: SavedTrace): Promise<PushResult> {
    if (!(await signedIn())) return 'signedout';
    // The saved_routes points column carries a 2..200-element check
    // constraint; an over-long trace would fail server-side with only a
    // log.warn to show for it. Truncating a route is a safety lie, so
    // refuse loudly instead.
    if (trace.points.length > 200) {
        log.warn(`push skipped for ${trace.id}: ${trace.points.length} points exceeds the 200-point sync cap`);
        return 'toolarge';
    }
    const { error } = await supabase!.from('saved_routes').upsert({
        id: trace.id,
        name: trace.name,
        points: trace.points.map((p) => [p.lat, p.lon]),
        created_at: trace.createdAt,
        updated_at: trace.updatedAt ?? new Date().toISOString(),
        deleted: false,
    });
    if (error) {
        log.warn(`push failed for ${trace.id}: ${error.message}`);
        return 'error';
    }
    return 'ok';
}

/** Tombstone a deleted trace on the account. Fire-and-forget. */
export async function pushSavedRouteDelete(id: string): Promise<void> {
    if (!(await signedIn())) return;
    const { error } = await supabase!.from('saved_routes').upsert({
        id,
        name: '(deleted)',
        points: [
            [0, 0],
            [0, 0],
        ],
        deleted: true,
        updated_at: new Date().toISOString(),
    });
    if (error) log.warn(`delete push failed for ${id}: ${error.message}`);
}

/**
 * Pull the account set and merge into localStorage. Account tombstones
 * remove local copies; local-only traces push up (a device that saved
 * offline catches the account up). Returns the merged list.
 */
export async function syncSavedRoutes(): Promise<SavedTrace[]> {
    const local = loadSavedTraces();
    if (!(await signedIn())) return local;
    try {
        const { data, error } = await supabase!
            .from('saved_routes')
            .select('id, name, points, created_at, updated_at, deleted')
            .order('updated_at', { ascending: false })
            .limit(100);
        if (error) throw new Error(error.message);
        const rows = data ?? [];
        const deletedIds = new Set(rows.filter((r) => r.deleted).map((r) => r.id as string));
        const remote: SavedTrace[] = rows
            .filter((r) => !r.deleted && Array.isArray(r.points))
            .map((r) => ({
                id: r.id as string,
                name: r.name as string,
                createdAt: (r.created_at as string) ?? new Date().toISOString(),
                ...(r.updated_at ? { updatedAt: r.updated_at as string } : {}),
                points: (r.points as [number, number][])
                    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
                    .map(([lat, lon]) => ({ lat, lon }) as TracePoint),
            }))
            .filter((t) => t.points.length >= 2);
        const remoteById = new Map(remote.map((t) => [t.id, t]));
        const stamp = (t: SavedTrace): number => new Date(t.updatedAt ?? t.createdAt).getTime();
        const localOnly = local.filter((t) => !remoteById.has(t.id) && !deletedIds.has(t.id));
        // Local overwrites that haven't reached the account yet (offline
        // save): same id, newer stamp — keep the local copy and push it up,
        // or this merge would silently revert the punter's edit.
        const localNewer = local.filter((t) => {
            const r = remoteById.get(t.id);
            return !!r && stamp(t) > stamp(r);
        });
        // Catch the account up with offline saves, best-effort.
        for (const t of [...localOnly, ...localNewer]) void pushSavedRoute(t);
        const localWins = new Set(localNewer.map((t) => t.id));
        const merged = [...localOnly, ...localNewer, ...remote.filter((t) => !localWins.has(t.id))].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        writeLocal(merged);
        return merged;
    } catch (err) {
        log.warn(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
        return local;
    }
}
