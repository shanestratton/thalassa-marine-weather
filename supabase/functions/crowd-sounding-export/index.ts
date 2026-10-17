import { handleCrowdExport } from './handler.ts';
Deno.serve((request: Request) =>
    handleCrowdExport(request, {
        enabled: Deno.env.get('CROWD_EXPORT_ENABLED') === 'true',
        tokenHash: Deno.env.get('CROWD_EXPORT_TOKEN_SHA256') ?? '',
        origin: Deno.env.get('SUPABASE_URL') ?? '',
        serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        fetch,
    })
);
