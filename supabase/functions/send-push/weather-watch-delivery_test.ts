import { createWeatherWatchDeliveryGuard } from './weather-watch-delivery.ts';
import { getApnsExpiration, getCollapseId, isCriticalType, isStaleForDelivery } from './config.ts';
const equal = (a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Guard assertion failed');
};
const id = '10000000-0000-4000-8000-000000000001';
const now = Date.now(),
    data = {
        weather_watch: 1,
        feature: 'rain',
        boat_id: id,
        revision: id,
        position_revision: id,
        expires: new Date(now + 600_000).toISOString(),
    };
Deno.test('weather opt-out/owner/CAS guard runs again before each retry; unknown remains retryable', async () => {
    let result: unknown = true, calls = 0;
    const guard = createWeatherWatchDeliveryGuard(id, data, async () => {
        calls++;
        return result;
    }, () => now);
    equal(await guard(), 'allow');
    result = false;
    equal(await guard(), 'retire');
    result = null;
    equal(await guard(), 'unavailable');
    equal(calls, 3);
});
Deno.test('weather expiry, invalid family and ids retire without any database call', async () => {
    let calls = 0;
    for (
        const broken of [{ ...data, weather_watch: '1' }, { ...data, feature: 'lightning' }, {
            ...data,
            boat_id: 'other',
        }, { ...data, expires: new Date(now - 1).toISOString() }]
    ) {
        equal(
            await createWeatherWatchDeliveryGuard(id, broken, async () => {
                calls++;
                return true;
            }, () => now)(),
            'retire',
        );
    }
    equal(calls, 0);
});
Deno.test('APNs honors the actual weather deadline; legacy weather and alarm priority remain unchanged', () => {
    equal(getApnsExpiration('weather_alert', false, now, data), String(Math.floor((now + 600_000) / 1000)));
    equal(getApnsExpiration('weather_alert', false, now, {}), String(Math.floor(now / 1000) + 3600));
    equal(isStaleForDelivery('weather_alert', new Date(now).toISOString(), now + 600_001, data), true);
    equal(getCollapseId('weather_alert', data), `wx-rain-${id}`);
    equal(isCriticalType('weather_alert'), false);
    equal(isCriticalType('anchor_alarm'), true);
});
