import { requireAuthenticatedQuota } from '../_shared/auth-rate-limit.ts';
import { handleLicensedLightning } from './handler.ts';
import { lightningRuntime } from './runtime.ts';
Deno.serve((request) =>
    handleLicensedLightning(
        request,
        lightningRuntime(async (req) => {
            const caller = await requireAuthenticatedQuota(req, 'licensed-lightning', 12, 3600);
            return caller instanceof Response ? caller : null;
        }, Deno.env),
    )
);
