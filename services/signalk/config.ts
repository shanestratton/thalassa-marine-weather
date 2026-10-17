import { authScopedStorageKey } from '../authIdentityScope';
export interface SignalKDeviceConfig {
    origin: string;
    clientId: string;
    allowInsecureLan: boolean;
    selected: boolean;
}
const KEY = 'thalassa-signalk-reader-v1';
export function signalKDeviceOrigin(raw: string, allowInsecureLan = false): string {
    try {
        if (typeof raw !== 'string' || raw.length > 2048) throw new Error();
        const u = new URL(raw.trim());
        if (
            u.username ||
            u.password ||
            u.search ||
            u.hash ||
            u.pathname !== '/' ||
            !['http:', 'https:'].includes(u.protocol)
        )
            throw new Error();
        const host = u.hostname.toLowerCase(),
            p = host.split('.').map(Number);
        const privateV4 =
            /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) &&
            p.every((n) => n >= 0 && n <= 255) &&
            (p[0] === 10 ||
                (p[0] === 192 && p[1] === 168) ||
                (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
                (p[0] === 169 && p[1] === 254));
        if (u.protocol === 'http:' && !(allowInsecureLan && (privateV4 || host.endsWith('.local')))) throw new Error();
        return u.origin;
    } catch {
        throw new Error('Use an HTTPS Signal K origin, or explicitly allow HTTP on your private boat network');
    }
}
export function readSignalKDeviceConfig(): SignalKDeviceConfig | null {
    try {
        const raw: unknown = JSON.parse(localStorage.getItem(authScopedStorageKey(KEY)) ?? 'null');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const v = raw as Record<string, unknown>;
        if (
            typeof v.origin !== 'string' ||
            typeof v.clientId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.clientId)
        )
            return null;
        return {
            origin: signalKDeviceOrigin(v.origin, v.allowInsecureLan === true),
            clientId: v.clientId,
            allowInsecureLan: v.allowInsecureLan === true,
            selected: v.selected === true,
        };
    } catch {
        return null;
    }
}
/** Preferences only. Device access tokens live in the this-device-only Keychain. */
export function saveSignalKDeviceConfig(config: SignalKDeviceConfig): void {
    const origin = signalKDeviceOrigin(config.origin, config.allowInsecureLan);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(config.clientId))
        throw new Error('Invalid Signal K device identifier');
    localStorage.setItem(authScopedStorageKey(KEY), JSON.stringify({ ...config, origin }));
}
