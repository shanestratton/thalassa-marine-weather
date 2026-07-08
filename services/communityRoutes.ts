/**
 * Community traced routes — the flywheel's server side (masterplan Phase 4,
 * schema `supabase/migrations/20260708120000_traced_routes.sql`).
 *
 * Locals trace their HOME marina exit — the water they know best; everyone
 * else consumes it as their ARRIVAL lane. The loop is consent-first and
 * harbourmaster-gated:
 *   • SUBMIT is an explicit tap ("Share with all skippers"), never automatic,
 *     and lands as `pending` — RLS forces own-uid + pending on insert.
 *   • NOTHING publishes until the harbourmaster (the owner account, keyed by
 *     email in RLS) approves it in the review queue.
 *   • CONSUMPTION is the identity-stripped `traced_routes_near` RPC (approved
 *     rows only). Shared routes carry the submitter's draft_m; the tracer
 *     re-grades every consumed line against the CONSUMER'S keel for free.
 */
import { supabase, isSupabaseConfigured } from './supabase';
import type { TracePoint, GhostLane } from './routeTracer';
import { traceBbox } from './routeTracer';
import { createLogger } from '../utils/createLogger';

const log = createLogger('communityRoutes');

export interface CommunityLane extends GhostLane {
    /** Keel the lane was validated against (metres), null if unrecorded. */
    draftM: number | null;
    name: string;
}

export interface PendingRoute {
    id: string;
    name: string;
    points: TracePoint[];
    draftM: number | null;
    submittedAt: string;
}

/** points arrive as [[lat, lon], ...] jsonb — tolerate junk rows. */
function parsePoints(raw: unknown): TracePoint[] {
    if (!Array.isArray(raw)) return [];
    const out: TracePoint[] = [];
    for (const p of raw) {
        if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
            out.push({ lat: Number(p[0]), lon: Number(p[1]) });
        }
    }
    return out;
}

/**
 * Submit the current trace for harbourmaster review. Requires a signed-in
 * user (RLS). Returns a skipper-readable outcome — never throws.
 */
export async function submitTracedRoute(
    name: string,
    points: readonly TracePoint[],
    draftM: number | null,
): Promise<{ ok: boolean; message: string }> {
    if (!isSupabaseConfigured() || !supabase) return { ok: false, message: 'No connection to Thalassa cloud' };
    if (points.length < 2) return { ok: false, message: 'Trace a route first' };
    const [w, s, e, n] = traceBbox(points, 0.005);
    const { error } = await supabase.from('traced_routes').insert({
        name: name.trim() || `Shared route (${points.length} pins)`,
        points: points.map((p) => [Number(p.lat.toFixed(6)), Number(p.lon.toFixed(6))]),
        draft_m: draftM,
        bbox_w: w,
        bbox_s: s,
        bbox_e: e,
        bbox_n: n,
    });
    if (error) {
        log.warn(`submit failed: ${error.message}`);
        return {
            ok: false,
            message:
                error.message.includes('JWT') || error.message.includes('auth')
                    ? 'Sign in to share routes'
                    : 'Could not submit — try again with signal',
        };
    }
    return { ok: true, message: 'Submitted for review — publishes once the harbourmaster approves it' };
}

// 10-min in-memory cache per bbox bucket — ghost-lane lookups fire on every
// pin drop; the community set changes at review cadence, not pin cadence.
const laneCache = new Map<string, { at: number; lanes: CommunityLane[] }>();
const LANE_CACHE_MS = 10 * 60_000;

/** Approved community lanes near a bbox — merged into the tracer's ghosts. */
export async function communityLanesNear(bbox: [number, number, number, number]): Promise<CommunityLane[]> {
    if (!isSupabaseConfigured() || !supabase) return [];
    const key = bbox.map((v) => v.toFixed(2)).join(',');
    const hit = laneCache.get(key);
    if (hit && Date.now() - hit.at < LANE_CACHE_MS) return hit.lanes;
    try {
        const { data, error } = await supabase.rpc('traced_routes_near', {
            w: bbox[0],
            s: bbox[1],
            e: bbox[2],
            n: bbox[3],
        });
        if (error) throw new Error(error.message);
        const lanes: CommunityLane[] = (Array.isArray(data) ? data : [])
            .map((r: { id: string; name: string; points: unknown; draft_m: number | null }) => ({
                id: `community-${r.id}`,
                name: r.name,
                points: parsePoints(r.points),
                draftM: r.draft_m,
            }))
            .filter((l) => l.points.length >= 2);
        laneCache.set(key, { at: Date.now(), lanes });
        return lanes;
    } catch (err) {
        log.warn(`lanes fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}

// ── Harbourmaster (owner-only via RLS — others just get empty lists) ──────

export async function listPendingRoutes(): Promise<PendingRoute[]> {
    if (!isSupabaseConfigured() || !supabase) return [];
    try {
        const { data, error } = await supabase
            .from('traced_routes')
            .select('id, name, points, draft_m, submitted_at')
            .eq('status', 'pending')
            .order('submitted_at', { ascending: true })
            .limit(25);
        if (error) throw new Error(error.message);
        return (data ?? [])
            .map((r) => ({
                id: r.id as string,
                name: r.name as string,
                points: parsePoints(r.points),
                draftM: (r.draft_m as number | null) ?? null,
                submittedAt: r.submitted_at as string,
            }))
            .filter((r) => r.points.length >= 2);
    } catch (err) {
        log.warn(`pending list failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}

export async function reviewRoute(id: string, verdict: 'approved' | 'rejected'): Promise<boolean> {
    if (!isSupabaseConfigured() || !supabase) return false;
    const { error } = await supabase
        .from('traced_routes')
        .update({ status: verdict, reviewed_at: new Date().toISOString() })
        .eq('id', id);
    if (error) {
        log.warn(`review failed: ${error.message}`);
        return false;
    }
    laneCache.clear(); // approved set changed — ghosts refetch fresh
    return true;
}
