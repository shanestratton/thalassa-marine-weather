import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { canPublishInstruments, publicInstrumentSnapshot, publicInstrumentTimeZone } from './public-instruments.ts';

/** The same owner-scoped privacy authority for full voyages and fast instruments. */
export async function readPublicInstrumentAuthority(db: SupabaseClient, ownerId: string) {
    const [hidden, active] = await Promise.all([
        db.from('voyage_log_hidden_voyages').select('voyage_id').eq('user_id', ownerId),
        db.from('voyages').select('id, departure_time, created_at')
            .eq('user_id', ownerId).eq('status', 'active').maybeSingle(),
    ]);
    const hiddenVoyageIds = new Set<string>(
        (hidden.data ?? []).flatMap((row) => typeof row.voyage_id === 'string' ? [row.voyage_id] : []),
    );
    const activeRow = active.data;
    const id = typeof activeRow?.id === 'string' ? activeRow.id : '';
    return {
        hiddenVoyageIds,
        trackVisibilityReadable: !hidden.error,
        activeRow,
        activeRowError: active.error,
        instrumentActiveVoyageAllowed: !active.error && (!id || !hiddenVoyageIds.has(id)),
    };
}

export async function readPublicInstruments(
    db: SupabaseClient,
    config: { owner_id: string; boat_id: string | null; public_instruments_enabled?: boolean | null },
    requestedTrip: string | null,
    authority: Awaited<ReturnType<typeof readPublicInstrumentAuthority>>,
    lookup: (lat: number, lon: number) => string,
    publishedPosition: Record<string, unknown> | null = null,
) {
    const boatId = config.boat_id;
    const instrumentsAllowed = canPublishInstruments({
        enabled: config.public_instruments_enabled,
        boatId,
        requestedTrip,
        visibilityReadable: authority.trackVisibilityReadable,
        activeVoyageAllowed: authority.instrumentActiveVoyageAllowed,
    });
    let instruments: ReturnType<typeof publicInstrumentSnapshot> = null;
    if (instrumentsAllowed && boatId) {
        const { data: cloud, error: instrumentError } = await db.from('vessel_telemetry')
            .select(
                'boat_id, reported_at, source, lat, lon, sog_kts, cog_deg, heading_deg, stw_kts, tws_kts, twa_deg, twd_deg, aws_kts, awa_deg, depth_m, water_temp_c, pressure_hpa, voltage_v, rpm, heel_deg, pitch_deg, rudder_deg, extra',
            )
            .eq('owner_id', config.owner_id).eq('boat_id', boatId).maybeSingle();
        if (!instrumentError) {
            const now = Date.now();
            instruments = publicInstrumentSnapshot(
                cloud,
                boatId,
                now,
                publicInstrumentTimeZone(cloud, boatId, publishedPosition, lookup, now),
            );
        }
    }
    return { instruments_shared: instrumentsAllowed, instruments, generated_at: new Date().toISOString() };
}
