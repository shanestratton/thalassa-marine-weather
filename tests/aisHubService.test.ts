/**
 * AisHubService public-beta tests.
 *
 * Native NMEA/AIS reception remains available, but the retired Capacitor 3
 * UDP contribution bridge must stay inert on every platform until a supported
 * transport is deliberately introduced and device-tested.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
        store[key] = value;
    },
    removeItem: (key: string) => {
        delete store[key];
    },
});

import { AisHubService } from '../services/AisHubService';

beforeEach(() => {
    Object.keys(store).forEach((key) => delete store[key]);
    AisHubService.destroy();
});

describe('AisHubService public-beta boundary', () => {
    it('retires a remembered legacy opt-in while retaining inert endpoint settings', () => {
        store.aishub_enabled = 'true';
        store.aishub_ip = '192.168.4.1';
        store.aishub_port = '5678';

        AisHubService.init();

        expect(localStorage.getItem('aishub_enabled')).toBe('false');
        expect(AisHubService.getConfig()).toEqual({
            enabled: false,
            ip: '192.168.4.1',
            port: 5678,
        });
    });

    it('refuses every enable request', () => {
        AisHubService.configure('192.168.4.1', 5678);
        AisHubService.setEnabled(true);

        expect(localStorage.getItem('aishub_enabled')).toBe('false');
        expect(AisHubService.getConfig().enabled).toBe(false);
        expect(AisHubService.getStats()).toEqual({
            sentenceCount: 0,
            bytesSent: 0,
            lastForwardedAt: 0,
            isActive: false,
            networkOk: false,
        });
    });

    it('never counts or transmits sentences even when legacy configuration exists', () => {
        AisHubService.configure('192.168.4.1', 5678);
        AisHubService.setEnabled(true);

        AisHubService.forward('!AIVDM,1,1,,B,15MwkT1P05Fo;H`EKP8a8:R`0@Fv,0*75');
        AisHubService.forward('!AIVDM,1,1,,B,13u@Dt002s000000000000000000,0*40');

        expect(AisHubService.getStats()).toEqual({
            sentenceCount: 0,
            bytesSent: 0,
            lastForwardedAt: 0,
            isActive: false,
            networkOk: false,
        });
    });

    it('notifies subscribers only with the inactive boundary state', () => {
        const listener = vi.fn();
        const unsubscribe = AisHubService.subscribe(listener);

        AisHubService.init();
        AisHubService.setEnabled(true);

        expect(listener).toHaveBeenCalledTimes(2);
        for (const [snapshot] of listener.mock.calls) {
            expect(snapshot).toEqual({
                sentenceCount: 0,
                bytesSent: 0,
                lastForwardedAt: 0,
                isActive: false,
                networkOk: false,
            });
        }

        unsubscribe();
    });
});
