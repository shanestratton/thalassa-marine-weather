import { handlePublisherRequest } from './handler.ts';
import { WX_PUBLISHER_TOKEN_SHA256 } from './tokenHash.ts';

Deno.serve((request: Request) =>
    handlePublisherRequest(request, {
        tokenHash: WX_PUBLISHER_TOKEN_SHA256,
        restBase: (Deno.env.get('SUPABASE_URL') || '') + '/rest/v1',
        serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
        fetch,
    })
);
