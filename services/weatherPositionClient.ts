import { supabase } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
import { satelliteModeActive } from './networkPolicy';
import { withTimeout } from '../utils/deadline';
import {
    parseWeatherPositionSource,
    weatherPositionUuid,
    weatherPositionHash,
    weatherPositionRelay,
    type WeatherPositionSource,
    type WeatherPositionRegistration,
} from '../utils/weatherPosition';
const reviewed = new WeakMap<WeatherPositionSource, { current: () => boolean; deviceId: string }>();
/** Explicit, fixed read from enrolled pinned boat LAN. No GPS substitution or WAN fallback. */
export async function reviewWeatherPositionSource(
    scope = getAuthIdentityScope(),
): Promise<WeatherPositionSource | null> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope) || document.visibilityState === 'hidden') return null;
    const [{ getPairing, getChartDevice, pinnedPiRequest }, { isPinnedTransportAvailable }, { piCache }, { App }] =
        await Promise.all([
            import('./PiPairingService'),
            import('./piTls'),
            import('./PiCacheService'),
            import('@capacitor/app'),
        ]);
    const pairing = getPairing(),
        base = piCache.lanBaseUrlNow();
    if (!pairing?.publicKeySpki || !base || !isPinnedTransportAvailable()) return null;
    const current = () => {
        const p = getPairing();
        return (
            isAuthIdentityScopeCurrent(scope) &&
            document.visibilityState !== 'hidden' &&
            isPinnedTransportAvailable() &&
            piCache.lanBaseUrlNow() === base &&
            p?.deviceId === pairing.deviceId &&
            p.publicKeySpki === pairing.publicKeySpki &&
            p.pairedAt === pairing.pairedAt
        );
    };
    const [device, foreground] = await Promise.all([getChartDevice(), App.getState()]);
    if (!device || !foreground.isActive || !current()) return null;
    const response = await withTimeout(
        pinnedPiRequest({
            url: `${base}/api/weather-watch/position-source`,
            method: 'GET',
            responseType: 'text',
            connectTimeout: 2500,
            readTimeout: 4000,
            isCurrent: current,
        }),
        null,
        7000,
    );
    if (
        !current() ||
        !response ||
        response.status !== 200 ||
        typeof response.data !== 'string' ||
        response.data.length > 2048 ||
        new TextEncoder().encode(response.data).length > 2048
    )
        return null;
    const [afterForeground, afterDevice] = await Promise.all([App.getState(), getChartDevice()]);
    if (!afterForeground.isActive || afterDevice?.chartDeviceId !== device.chartDeviceId || !current()) return null;
    try {
        const source = parseWeatherPositionSource(JSON.parse(response.data), Date.now());
        if (!source || source.ownerId !== scope.userId || source.piDeviceId !== pairing.deviceId || !current())
            return null;
        Object.freeze(source.position);
        Object.freeze(source);
        reviewed.set(source, { current, deviceId: device.chartDeviceId });
        return source;
    } catch {
        return null;
    }
}
/** Source changes always require a fresh explicit owner CAS, never an automatic adoption. */
export async function saveWeatherPositionSource(
    boatId: string,
    expected: string | null,
    source: WeatherPositionSource | WeatherPositionRegistration,
    enabled: boolean,
    scope: AuthIdentityScope,
): Promise<string> {
    if (
        !supabase ||
        !scope.userId ||
        !isAuthIdentityScopeCurrent(scope) ||
        satelliteModeActive() ||
        !weatherPositionUuid(boatId) ||
        (expected !== null && !weatherPositionUuid(expected)) ||
        !weatherPositionRelay(source.relayId) ||
        !weatherPositionHash(source.selfKey) ||
        !weatherPositionHash(source.sourceKey) ||
        typeof enabled !== 'boolean' ||
        (enabled && !parseWeatherPositionSource(source, Date.now()))
    )
        throw new Error('Read a fresh paired Pi source before allowing position sharing.');
    if (enabled) {
        const evidence = reviewed.get(source as WeatherPositionSource);
        if (!evidence || !evidence.current() || (source as WeatherPositionSource).ownerId !== scope.userId)
            throw new Error('Read a fresh paired Pi source before allowing position sharing.');
        const { getChartDevice } = await import('./PiPairingService');
        const device = await getChartDevice();
        if (
            !evidence.current() ||
            device?.chartDeviceId !== evidence.deviceId ||
            !parseWeatherPositionSource(source, Date.now()) ||
            satelliteModeActive()
        )
            throw new Error('Read a fresh paired Pi source before allowing position sharing.');
    }
    const result = await withTimeout(
        Promise.resolve(
            supabase.rpc('configure_weather_position', {
                p_boat_id: boatId,
                p_expected: expected,
                p_relay_id: source.relayId,
                p_self_key: source.selfKey,
                p_source_key: source.sourceKey,
                p_enabled: enabled,
            }),
        ),
        null,
        5000,
    );
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed.');
    if (result?.error?.code === '40001')
        throw new Error('Position source changed on another phone. Reload and review it.');
    if (!result || result.error || !result.data || !weatherPositionUuid(result.data.revision))
        throw new Error('Position sharing not confirmed. Reload before retrying.');
    return result.data.revision;
}
