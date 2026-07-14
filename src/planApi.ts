/**
 * planApi — fetch + URL parsing for the standalone public Passage Plan
 * page (<handle>.thalassawx.app/plan). Mirrors voyageLogApi's shape so
 * the two public surfaces stay recognisably one product.
 */

const SUPABASE_URL: string =
    (import.meta.env.VITE_SUPABASE_URL as string | undefined) || process.env.SUPABASE_URL || '';

export interface PlanWaypoint {
    lat: number;
    lon: number;
    name: string | null;
}

export interface FloatPlan {
    name: string | null;
    origin: string | null;
    destination: string | null;
    departure_at: string | null;
    eta_at: string | null;
    planned_nm: number;
    waypoints: PlanWaypoint[];
    /** Curved sea-path coordinates [[lon, lat], …] when the save carried
     *  route geometry; null → draw the waypoint polyline instead. */
    route: [number, number][] | null;
    saved_at: string | null;
}

export interface FloatPlanData {
    vessel: { name: string; type: string; model: string | null };
    plan: FloatPlan | null;
    generated_at: string;
}

export class FloatPlanError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
        this.name = 'FloatPlanError';
    }
}

/** Fetch a vessel's published passage plan. Throws FloatPlanError on failure. */
export async function fetchFloatPlan(handle: string): Promise<FloatPlanData> {
    if (!SUPABASE_URL) {
        throw new FloatPlanError(0, 'Plan API URL is not configured for this build.');
    }
    const url = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/float-plan?handle=${encodeURIComponent(handle)}`;
    let res: Response;
    try {
        res = await fetch(url);
    } catch {
        throw new FloatPlanError(0, 'Could not reach the Plan API — check your connection.');
    }
    if (!res.ok) {
        let message = `Request failed (${res.status})`;
        try {
            const body = await res.json();
            if (body?.error) message = body.error as string;
        } catch {
            /* non-JSON error body */
        }
        throw new FloatPlanError(res.status, message);
    }
    return (await res.json()) as FloatPlanData;
}

/**
 * Pull the vessel handle out of the page URL. Accepts:
 *   1. <handle>.thalassawx.app/plan   (subdomain — production)
 *   2. /plan/<handle>                 (path — share-by-path)
 *   3. /plan?handle=<handle>          (query — local dev)
 */
export function parsePlanParams(): { handle: string } {
    const host = window.location.hostname;
    const hostParts = host.split('.');
    if (hostParts.length >= 3 && hostParts[0] !== 'www' && host !== 'thalassawx.app') {
        return { handle: hostParts[0] };
    }
    const m = window.location.pathname.replace(/\/+$/, '').match(/\/plan\/([^/]+)/);
    if (m) return { handle: decodeURIComponent(m[1]) };
    const q = new URLSearchParams(window.location.search).get('handle');
    return { handle: q ?? '' };
}
