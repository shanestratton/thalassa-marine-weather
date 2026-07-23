/**
 * float-plan — Public Passage Plan API
 *
 * Serves a vessel's LATEST saved passage plan as JSON: the float-plan
 * surface — shore crew open <handle>.thalassawx.app/plan and see where
 * the boat intends to go, when it left/leaves, and the planned route.
 *
 * Public, read-only, no API key — gated by the same voyage_log_configs
 * handle + `enabled` flag as the voyage log (one public identity per
 * boat, one revocation switch).
 *
 *   GET /functions/v1/float-plan?handle=<handle>
 *
 * Data model: saved plans are ship_logs rows whose voyage_id starts
 * with "planned_" (PassagePlanSave.ts). The first (Departure) row's
 * notes carry "__route_geometry__::<coords JSON>" and a "Planned: X → Y"
 * summary line; waypoint rows carry waypoint_name.
 *
 * Response 200:
 *   {
 *     vessel: { name, type, model },
 *     plan: {
 *       name, origin, destination,
 *       departure_at, eta_at, planned_nm,
 *       waypoints: [{ lat, lon, name }],
 *       route: [[lon, lat], ...] | null,   // curved sea path when saved
 *       saved_at
 *     } | null,                            // null = no plan published
 *     generated_at
 *   }
 *
 * Errors: 400 missing handle · 403 disabled · 404 unknown handle.
 * Deploy with JWT verification OFF (public function), same as voyage-log.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { jsonResponse } from '../_shared/http-security.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ROUTE_GEOMETRY_NOTES_PREFIX = '__route_geometry__::';

function json(body: unknown, status = 200) {
    return jsonResponse(body, status, corsHeaders);
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'GET') return json({ error: 'GET only' }, 405);

    const caller = await requireAuthenticatedOrPublicQuota(req, 'float_plan', 240, 60, 3600, true);
    if (caller instanceof Response) return withCors(caller, corsHeaders);

    try {
        const handle = new URL(req.url).searchParams.get('handle')?.trim().toLowerCase() ?? '';
        if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(handle)) {
            return json({ error: 'A valid handle is required' }, 400);
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!supabaseUrl || !serviceRoleKey) return json({ error: 'Service unavailable' }, 503);
        const supabase = createClient(supabaseUrl, serviceRoleKey);

        // ── Resolve the public identity (same gate as voyage-log) ──
        const { data: config, error: configErr } = await supabase
            .from('voyage_log_configs')
            .select('owner_id, boat_id, enabled')
            .eq('handle', handle)
            .maybeSingle();
        if (configErr) {
            console.error('float-plan: config lookup failed:', configErr);
            return json({ error: 'Internal server error' }, 500);
        }
        if (!config) return json({ error: 'Unknown vessel handle' }, 404);
        if (!config.enabled) return json({ error: 'This vessel page is not currently public' }, 403);

        const ownerId = config.owner_id as string;
        const boatId = config.boat_id as string | null;

        // ── Vessel identity (boats first, personal identity fallback) ──
        const vesselRes = boatId
            ? await supabase.from('boats').select('name, vessel_type, model').eq('id', boatId).maybeSingle()
            : await supabase
                  .from('vessel_identity')
                  .select('vessel_name, vessel_type, model')
                  .eq('user_id', ownerId)
                  .maybeSingle();
        const vData = vesselRes.data as Record<string, unknown> | null;
        const vessel = {
            name: (vData?.name as string) ?? (vData?.vessel_name as string) ?? 'Unnamed Vessel',
            type: (vData?.vessel_type as string) ?? 'sail',
            model: (vData?.model as string) ?? null,
        };

        // ── Latest saved plan: newest planned_* voyage by save time ──
        // Schema-drift armour (the voyage-log lesson): if created_at is
        // missing on this deployment, fall back to ordering by id — the
        // save stamps all rows in one batch, so any stable tiebreaker
        // beats erroring out to a silent "no plan".
        let newest = await supabase
            .from('ship_logs')
            .select('voyage_id, created_at')
            .eq('user_id', ownerId)
            .like('voyage_id', 'planned_%')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (newest.error) {
            console.error('float-plan: created_at order failed, falling back:', newest.error.message);
            newest = await supabase
                .from('ship_logs')
                .select('voyage_id')
                .eq('user_id', ownerId)
                .like('voyage_id', 'planned_%')
                .order('id', { ascending: false })
                .limit(1)
                .maybeSingle();
        }
        if (newest.error) console.error('float-plan: plan lookup failed:', newest.error.message);

        let plan: Record<string, unknown> | null = null;
        const planVoyageId = ((newest.data as Record<string, unknown> | null)?.voyage_id as string | undefined) ?? null;
        if (planVoyageId) {
            const { data: rows, error: rowsErr } = await supabase
                .from('ship_logs')
                .select('latitude, longitude, entry_type, waypoint_name, notes, timestamp, cumulative_distance_nm')
                .eq('user_id', ownerId)
                .eq('voyage_id', planVoyageId)
                .order('timestamp', { ascending: true })
                .limit(1000);
            if (rowsErr) console.error('float-plan: plan rows failed:', rowsErr.message);
            const pts = (rows ?? []) as Record<string, unknown>[];
            if (pts.length >= 2) {
                // Name + route geometry live on the first row's notes.
                const firstNotes = String(pts[0].notes ?? '');
                const nameMatch = firstNotes.match(/^Planned:\s*(.+)$/m);
                const name = nameMatch ? nameMatch[1].trim() : null;
                const [origin, destination] = (name ?? '').split('→').map((s) => s.trim());

                let route: unknown = null;
                const geomLine = firstNotes.split('\n').find((l) => l.startsWith(ROUTE_GEOMETRY_NOTES_PREFIX));
                if (geomLine) {
                    try {
                        const parsed: unknown = JSON.parse(geomLine.slice(ROUTE_GEOMETRY_NOTES_PREFIX.length));
                        if (Array.isArray(parsed) && parsed.length <= 5_000) {
                            const coordinates = parsed.filter(
                                (point): point is [number, number] =>
                                    Array.isArray(point) &&
                                    point.length >= 2 &&
                                    typeof point[0] === 'number' &&
                                    Number.isFinite(point[0]) &&
                                    Math.abs(point[0]) <= 180 &&
                                    typeof point[1] === 'number' &&
                                    Number.isFinite(point[1]) &&
                                    Math.abs(point[1]) <= 90,
                            );
                            route = coordinates.length === parsed.length ? coordinates : null;
                        }
                    } catch {
                        route = null;
                    }
                }

                const waypoints = pts
                    .filter((p) => p.entry_type === 'waypoint' || pts.length <= 24)
                    .map((p) => ({
                        lat: p.latitude as number,
                        lon: p.longitude as number,
                        name: (p.waypoint_name as string) ?? null,
                    }));

                const plannedNM = Math.max(
                    0,
                    ...pts.map((p) =>
                        typeof p.cumulative_distance_nm === 'number' ? (p.cumulative_distance_nm as number) : 0,
                    ),
                );

                plan = {
                    name,
                    origin: origin || null,
                    destination: destination || null,
                    departure_at: pts[0].timestamp ?? null,
                    eta_at: pts[pts.length - 1].timestamp ?? null,
                    planned_nm: Math.round(plannedNM * 10) / 10,
                    waypoints,
                    route,
                    saved_at:
                        ((newest.data as Record<string, unknown> | null)?.created_at as string | undefined) ?? null,
                };
            }
        }

        return json({ vessel, plan, generated_at: new Date().toISOString() }, 200);
    } catch (err) {
        console.error('float-plan: unhandled error:', err);
        return json({ error: 'Internal server error' }, 500);
    }
});
