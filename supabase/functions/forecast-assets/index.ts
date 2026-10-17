import { consumePublicQuota } from '../_shared/auth-rate-limit.ts';
import { createForecastAssetsHandler, FORECAST_PUBLIC_QUOTA } from './handler.ts';

Deno.serve(createForecastAssetsHandler((request, signal) =>
    consumePublicQuota(
        request,
        FORECAST_PUBLIC_QUOTA.bucket,
        FORECAST_PUBLIC_QUOTA.limit,
        FORECAST_PUBLIC_QUOTA.windowSeconds,
        signal,
    )
));
