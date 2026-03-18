/**
 * vessels-nearby — Supabase Edge Function
 *
 * Returns AIS vessels within a radius of a given point.
 * Used by the Thalassa app to populate the map with server-side AIS data.
 *
 * Query params:
 *   lat    — latitude (required)
 *   lon    — longitude (required)
 *   radius — radius in nautical miles (default: 25)
 *   limit  — max results (default: 500)
 *
 * Returns: GeoJSON FeatureCollection
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const url = new URL(req.url);
        const lat = parseFloat(url.searchParams.get('lat') || '');
        const lon = parseFloat(url.searchParams.get('lon') || '');
        const radiusNm = parseFloat(url.searchParams.get('radius') || '25');
        const limit = parseInt(url.searchParams.get('limit') || '500', 10);

        if (isNaN(lat) || isNaN(lon)) {
            return new Response(JSON.stringify({ error: 'lat and lon are required query parameters' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Convert nautical miles to meters (1 NM = 1852 m)
        const radiusMeters = radiusNm * 1852;

        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        );

        // Spatial query using ST_DWithin on geography column
        const { data, error } = await supabase.rpc('vessels_nearby', {
            query_lat: lat,
            query_lon: lon,
            radius_m: radiusMeters,
            max_results: limit,
        });

        if (error) {
            console.error('vessels_nearby RPC error:', error);
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Build GeoJSON FeatureCollection
        const features = (data || []).map((v: any) => ({
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [v.lon, v.lat],
            },
            properties: {
                mmsi: v.mmsi,
                name: v.name || `MMSI ${v.mmsi}`,
                callSign: v.call_sign,
                shipType: v.ship_type,
                destination: v.destination,
                cog: v.cog,
                sog: v.sog,
                heading: v.heading,
                navStatus: v.nav_status,
                updatedAt: v.updated_at,
                source: 'aisstream', // Distinguishes from local NMEA AIS
            },
        }));

        const geojson = {
            type: 'FeatureCollection',
            features,
        };

        return new Response(JSON.stringify(geojson), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    } catch (e) {
        console.error('Edge function error:', e);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});
