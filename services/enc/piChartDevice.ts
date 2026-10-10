/**
 * This phone's place in the boat's chart vault (127-C-d, the app half of Pi
 * update 3).
 *
 * From update 3 the Pi serves charts only to phones and tablets it enrolled by
 * a one-time code, at most five, over the boat's own Wi-Fi. The first code is
 * printed at the Pi's install; an enrolled device can mint more. The token the
 * Pi issues is kept by PiPairingService (Keychain, this device only) and sent
 * as one header on /api/enc/*.
 *
 * The routes, as this module reads them (Pi update 3, decisions 4-5):
 *   GET    /api/enc/devices/status  { enrolled, removed?, cells?, vault? }
 *          Untokened, so it answers 200 for a phone that is not set up. A Pi
 *          that checks a token it was sent before it gets here may instead
 *          answer 401 chart-device-not-enrolled or chart-device-removed: both
 *          read as "not set up", with the code field.
 *   POST   /api/enc/devices/enrol   { code, label } -> { deviceId, token }
 *   GET    /api/enc/devices         { devices: [{ id, label, enrolledAt?, lastSeenAt? }], maxDevices? }
 *   POST   /api/enc/devices/code    { code, expiresAt? }
 *   DELETE /api/enc/devices/:id
 * A refusal is `{code}` with its status (piChartAccessWords.ts has the words).
 *
 * Today's Pi (update 2) has none of these routes, and Express answers with its
 * own 404 page. That reads as 'pi-needs-update', never an error: the 127 app
 * goes on the phone before the Pi update (decision 15), and charts keep
 * loading from the old Pi exactly as before.
 */

import { piCache } from '../PiCacheService';
import { dropChartDevice, getChartDevice, piHttpError, pinnedPiRequest, saveChartDevice } from '../PiPairingService';
import type { PiHttpError } from '../PiPairingService';

export interface ChartDeviceEntry {
    id: string;
    label: string;
    addedAt?: string;
    seenAt?: string;
    self: boolean;
}

export type ChartAccess =
    | { kind: 'not-set-up'; removed: boolean }
    /** `vault` is a piChartAccessWords code when the vault has something to say ('ready' has not). */
    | { kind: 'set-up'; devices: ChartDeviceEntry[]; max: number; cells?: number; vault?: string }
    /** Anything else, as a piChartAccessWords code: a refusal, 'pi-needs-update', or none (no answer). */
    | { kind: 'said'; code?: string };

interface DeviceRow {
    id?: unknown;
    label?: unknown;
    enrolledAt?: unknown;
    lastSeenAt?: unknown;
}

const whole = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined);
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/**
 * The piChartAccessWords code for a failed /api/enc/devices call: the Pi's
 * own, or 'pi-needs-update' for a code-less 404 (today's Pi has none of these
 * routes), or none when the Pi did not answer at all. Elsewhere a code-less
 * 404 can mean something else (EncImportService's missing job receipt).
 */
export function chartCodeOf(error: unknown): string | undefined {
    const refusal = error as Partial<PiHttpError> | undefined;
    if (refusal?.name !== 'PiHttpError') return undefined;
    return refusal.code ?? (refusal.status === 404 ? 'pi-needs-update' : undefined);
}

async function devices<T>(path = '', method: 'GET' | 'POST' | 'DELETE' = 'GET', data?: unknown): Promise<T> {
    const res = await pinnedPiRequest({
        url: `${piCache.baseUrl}/api/enc/devices${path}`,
        method,
        headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
        data,
        connectTimeout: 4000,
        readTimeout: 8000,
        responseType: 'text',
    });
    if (res.status < 200 || res.status >= 300) throw piHttpError(res);
    return JSON.parse(res.data || '{}') as T;
}

/** What the paired Pi says about this phone and its charts. Never throws. */
export async function loadChartAccess(): Promise<ChartAccess> {
    try {
        const status = await devices<{ enrolled?: unknown; removed?: unknown; cells?: unknown; vault?: unknown }>(
            '/status',
        );
        if (status.enrolled !== true) {
            // Removed from another device: the token is dead, so stop sending it.
            if (status.removed === true) dropChartDevice();
            return { kind: 'not-set-up', removed: status.removed === true };
        }
        const [mine, list] = await Promise.all([
            getChartDevice(),
            devices<{ devices?: unknown; maxDevices?: unknown }>(),
        ]);
        const vault = String(status.vault);
        return {
            kind: 'set-up',
            devices: (Array.isArray(list.devices) ? (list.devices as DeviceRow[]) : [])
                .filter((d) => typeof d?.id === 'string')
                .map((d) => ({
                    id: d.id as string,
                    label: text(d.label) ?? 'Device',
                    addedAt: text(d.enrolledAt),
                    seenAt: text(d.lastSeenAt),
                    self: d.id === mine?.chartDeviceId,
                })),
            max: whole(list.maxDevices) ?? 5,
            cells: whole(status.cells),
            vault: /^(starting|busy|decoder-down)$/.test(vault) ? `vault-${vault}` : undefined,
        };
    } catch (error) {
        const code = chartCodeOf(error);
        const removed = code === 'chart-device-removed';
        return removed || code === 'chart-device-not-enrolled'
            ? { kind: 'not-set-up', removed }
            : { kind: 'said', code };
    }
}

/**
 * Crockford base32, as the Pi issues codes: ten characters, read without
 * spaces or dashes, O as 0 and I or L as 1. Null when it cannot be a code.
 */
export function normaliseChartCode(input: string): string | null {
    const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code) ? code : null;
}

/** What this device is, in the skipper's words (Thalassa ships on iOS). */
export function thisDeviceKind(): 'iPhone' | 'iPad' {
    const ua = navigator.userAgent;
    return /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : 'iPhone';
}

/**
 * Enrol this phone with a code. A refusal throws PiHttpError (chartCodeOf has
 * its words code). False when the Keychain would not keep the token, so this
 * phone has charts only until the app closes.
 */
export async function enrolChartDevice(input: string): Promise<boolean> {
    const code = normaliseChartCode(input);
    if (!code) throw new Error('Not a code');
    const { deviceId, token } = await devices<{ deviceId?: unknown; token?: unknown }>('/enrol', 'POST', {
        code,
        label: thisDeviceKind(),
    });
    if (
        typeof deviceId !== 'string' ||
        !/^[\w-]{1,64}$/.test(deviceId) ||
        typeof token !== 'string' ||
        !/^[\w-]{43}$/.test(token)
    ) {
        throw new Error('Unusable enrolment');
    }
    return saveChartDevice({ chartDeviceId: deviceId, token });
}

/** A one-time code for another phone or tablet (this one must be enrolled). */
export async function mintChartCode(): Promise<string> {
    const { code } = await devices<{ code?: unknown }>('/code', 'POST', {});
    const normal = typeof code === 'string' && normaliseChartCode(code);
    if (!normal) throw new Error('No code');
    return normal;
}

/** Take a device off the boat's list. Removing this one forgets its token too. */
export async function removeChartDevice(id: string): Promise<void> {
    const mine = await getChartDevice();
    await devices(`/${encodeURIComponent(id)}`, 'DELETE');
    if (mine?.chartDeviceId === id) dropChartDevice();
}
