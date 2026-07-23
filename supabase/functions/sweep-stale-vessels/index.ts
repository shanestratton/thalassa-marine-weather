/**
 * sweep-stale-vessels — Supabase Edge Function (Cron)
 *
 * Deletes vessels from the vessels table that haven't been
 * updated in 24 hours. Trigger via pg_cron every 6 hours.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { jsonResponse, requireServiceRolePost } from '../_shared/http-security.ts';

Deno.serve(async (req: Request) => {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const authorizationFailure = requireServiceRolePost(req, serviceRoleKey);
    if (authorizationFailure) return authorizationFailure;

    try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: 'Server database is not configured' }, 500);
        const supabase = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        // Call the PL/pgSQL function defined in the migration
        const { data, error } = await supabase.rpc('sweep_stale_vessels', {
            max_age_hours: 24,
        });

        if (error) {
            console.error('sweep_stale_vessels error:', error);
            return jsonResponse({ error: 'Stale vessel sweep failed' }, 500);
        }

        const deletedCount = data ?? 0;
        console.log(`[SWEEP] Deleted ${deletedCount} stale vessels`);

        return jsonResponse({ deleted: deletedCount, timestamp: new Date().toISOString() });
    } catch (e) {
        console.error('Sweep error:', e);
        return jsonResponse({ error: 'Internal server error' }, 500);
    }
});
