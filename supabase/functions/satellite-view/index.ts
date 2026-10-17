import { consumePublicQuota } from '../_shared/auth-rate-limit.ts';
import { createPublicSatelliteViewHandler, SATELLITE_PUBLIC_QUOTA } from './handler.ts';

Deno.serve(createPublicSatelliteViewHandler(
    () => Deno.env.get('SATELLITE_VIEW_ENABLED') === 'true',
    (request, signal) =>
        consumePublicQuota(
            request,
            SATELLITE_PUBLIC_QUOTA.bucket,
            SATELLITE_PUBLIC_QUOTA.limit,
            SATELLITE_PUBLIC_QUOTA.windowSeconds,
            signal,
        ),
));
