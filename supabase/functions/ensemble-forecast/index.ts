import { requireAuthenticatedQuota } from '../_shared/auth-rate-limit.ts';
import { handleEnsemble } from './handler.ts';

Deno.serve((req: Request) =>
    handleEnsemble(req, {
        authorize: async (request) => {
            const caller = await requireAuthenticatedQuota(request, 'ensemble-forecast', 12, 3600);
            return caller instanceof Response ? caller : null;
        },
        key: () => Deno.env.get('OPEN_METEO_API_KEY'),
        fetch,
        now: Date.now,
    })
);
