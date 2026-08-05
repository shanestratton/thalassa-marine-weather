import { CapacitorHttp } from '@capacitor/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    _resetWxServerCacheForTest,
    isWxServerAvailable,
    resolveWxServerBase,
    wxServerBase,
} from '../services/weather/wxServer';

const capacitorHttp = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: vi.fn().mockReturnValue(false) },
    CapacitorHttp: { get: capacitorHttp.get },
}));

describe('private weather-server public-beta boundary', () => {
    beforeEach(() => {
        _resetWxServerCacheForTest();
        vi.restoreAllMocks();
        capacitorHttp.get.mockReset();
    });

    it('is unavailable in production even if an endpoint and opt-in are supplied', () => {
        expect(resolveWxServerBase({ dev: false, enabled: 'true', base: 'http://private-weather.invalid:8080' })).toBe(
            '',
        );
    });

    it.each([undefined, '', 'false', 'TRUE', ' true '])(
        'rejects a missing or ambiguous development opt-in %j',
        (enabled) => {
            expect(resolveWxServerBase({ dev: true, enabled, base: 'http://private-weather.invalid:8080' })).toBe('');
        },
    );

    it('accepts only an explicit development opt-in with a safe HTTP(S) base', () => {
        expect(resolveWxServerBase({ dev: true, enabled: 'true', base: 'http://private-weather.invalid:8080/' })).toBe(
            'http://private-weather.invalid:8080',
        );
        expect(resolveWxServerBase({ dev: true, enabled: 'true', base: 'file:///tmp/weather' })).toBe('');
        expect(resolveWxServerBase({ dev: true, enabled: 'true', base: 'http://user:pass@private.invalid' })).toBe('');
    });

    it('does not probe when the build has no explicitly enabled endpoint', async () => {
        const get = vi.spyOn(CapacitorHttp, 'get');

        expect(wxServerBase()).toBe('');
        await expect(isWxServerAvailable()).resolves.toBe(false);
        expect(get).not.toHaveBeenCalled();
    });

    it('contains no private address fallback in release source', () => {
        const source = readFileSync(resolve(process.cwd(), 'services/weather/wxServer.ts'), 'utf8');

        expect(source).not.toContain('100.76.191.119');
        expect(source).not.toContain('DEFAULT_BASE');
        expect(source).toContain("if (!config.dev || config.enabled !== 'true') return ''");
    });
});
