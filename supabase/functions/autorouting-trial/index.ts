import { requireAuthenticatedQuota } from '../_shared/auth-rate-limit.ts';
import { createAutoroutingTrialHandler } from '../_shared/autorouting-trial.ts';

Deno.serve(createAutoroutingTrialHandler({
    env: (name) => Deno.env.get(name),
    authorize: requireAuthenticatedQuota,
    fetch,
}));
