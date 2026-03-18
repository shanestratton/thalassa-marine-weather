/**
 * sweep-stale-vessels — Supabase Edge Function (Cron)
 *
 * Deletes vessels from the vessels table that haven't been
 * updated in 24 hours. Trigger via pg_cron every 6 hours.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        );

        // Call the PL/pgSQL function defined in the migration
        const { data, error } = await supabase.rpc('sweep_stale_vessels', {
            max_age_hours: 24,
        });

        if (error) {
            console.error('sweep_stale_vessels error:', error);
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const deletedCount = data ?? 0;
        console.log(`[SWEEP] Deleted ${deletedCount} stale vessels`);

        return new Response(JSON.stringify({ deleted: deletedCount, timestamp: new Date().toISOString() }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    } catch (e) {
        console.error('Sweep error:', e);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});
