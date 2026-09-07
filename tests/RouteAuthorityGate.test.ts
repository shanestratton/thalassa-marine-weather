import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The dark "skipper is god" gate (Shane 2026-09-08: "this is where we probably
 * need the skippers device to be god"). Default 'confirm' asks and names the
 * other device; 'skipper' lets only the claim holder through — and stays OFF
 * until Shane switches it on (no new hard gates without his yes).
 */
import {
    ROUTE_AUTHORITY_DEFAULT,
    currentRouteAuthorityMode,
    currentRouteReplaceDecision,
    routeReplaceDecision,
} from '../services/shiplog/routeAuthority';
import { useSettingsStore } from '../stores/settingsStore';
import { getDeviceId } from '../services/skipperDevice';

beforeEach(() => {
    localStorage.clear();
    const settings = useSettingsStore.getState().settings;
    useSettingsStore.setState({ settings: { ...settings, routeAuthority: undefined, skipperDevice: undefined } });
});

describe('routeReplaceDecision', () => {
    it('defaults to asking, whoever holds the claim', () => {
        expect(ROUTE_AUTHORITY_DEFAULT).toBe('confirm');
        expect(routeReplaceDecision(undefined, false)).toBe('confirm');
        expect(routeReplaceDecision(undefined, true)).toBe('confirm');
        expect(routeReplaceDecision('confirm', true)).toBe('confirm');
    });

    it("'skipper' lets the claim holder through and refuses everyone else", () => {
        expect(routeReplaceDecision('skipper', true)).toBe('replace');
        expect(routeReplaceDecision('skipper', false)).toBe('refuse');
    });
});

describe('the setting is read from the store and ships dark', () => {
    it('unset reads as confirm', () => {
        expect(currentRouteAuthorityMode()).toBe('confirm');
        expect(currentRouteReplaceDecision()).toBe('confirm');
    });

    it("'skipper' + this device's claim → replace; another device's claim → refuse", () => {
        const settings = useSettingsStore.getState().settings;
        useSettingsStore.setState({
            settings: {
                ...settings,
                routeAuthority: 'skipper',
                skipperDevice: { deviceId: getDeviceId(), deviceName: 'me', claimedAt: '2026-09-08T00:00:00.000Z' },
            },
        });
        expect(currentRouteReplaceDecision()).toBe('replace');
        useSettingsStore.setState({
            settings: {
                ...useSettingsStore.getState().settings,
                skipperDevice: { deviceId: 'dev-other', deviceName: 'iPad', claimedAt: '2026-09-08T00:00:00.000Z' },
            },
        });
        expect(currentRouteReplaceDecision()).toBe('refuse');
    });
});
