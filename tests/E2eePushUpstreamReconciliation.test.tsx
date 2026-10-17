/**
 * Reconciled push behavior using the real local service, bootstrap hook, toast,
 * pin store and denial-only cutover policy. Native callbacks, ancillary boot
 * services and refresh transports are mocked. Not APNs, real Auth or E2EE proof.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivateMessageCutoverPolicy } from '../services/chat/e2ee/privateMessageCutover';

const f = vi.hoisted(() => ({
    callbacks: new Map<string, (payload: unknown) => void>(),
    addListener: vi.fn(),
    setPage: vi.fn(),
    haptic: vi.fn(),
    wakeRefresh: vi.fn(),
    radarRefresh: vi.fn(),
    log: vi.fn(),
    policy: null as PrivateMessageCutoverPolicy | null,
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
}));
vi.mock('@capacitor/push-notifications', () => ({
    PushNotifications: {
        addListener: f.addListener,
        removeAllDeliveredNotifications: vi.fn(async () => undefined),
        register: vi.fn(async () => undefined),
        unregister: vi.fn(async () => undefined),
    },
}));
// This local UI suite must never acquire a real Supabase client. No device
// token is supplied, so an Auth/RPC request is an unexpected test failure.
vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getUser: vi.fn(() => {
                throw new Error('Unexpected Auth query in local push reconciliation test');
            }),
        },
        rpc: vi.fn(() => {
            throw new Error('Unexpected RPC in local push reconciliation test');
        }),
    },
}));
vi.mock('../services/chat/e2ee/privateMessageCutover', async (original) => {
    const actual = await original<typeof import('../services/chat/e2ee/privateMessageCutover')>();
    return {
        ...actual,
        captureLegacyPrivateMessagePermit: (
            ...args: Parameters<PrivateMessageCutoverPolicy['captureLegacyPrivateMessagePermit']>
        ) => f.policy!.captureLegacyPrivateMessagePermit(...args),
        isLegacyPrivateMessagePermitCurrent: (permit: unknown) => f.policy!.isLegacyPrivateMessagePermitCurrent(permit),
        subscribePrivateMessageCutover: (listener: () => void) => f.policy!.subscribePrivateMessageCutover(listener),
    };
});
vi.mock('../utils/system', () => ({ triggerHaptic: f.haptic }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: f.log, debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../context/UIContext', () => ({ useUI: () => ({ currentView: 'dashboard', setPage: f.setPage }) }));
// No authenticated boot jobs are needed to exercise push routing. The actual
// local identity fence still owns the real service callbacks below.
vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { authChecked: boolean; user: null }) => unknown) =>
        selector({ authChecked: false, user: null }),
    currentAppleCredentialAccount: () => null,
}));
vi.mock('../services/piPublicBetaBoundary', () => ({ PI_INTEGRATION_ENABLED: false }));
vi.mock('../services/seabed/seabedSink', () => ({ seabedLocallyEnabled: () => false }));
vi.mock('../services/sightings/outboxFlag', () => ({ sightingsOutboxFlagged: () => false }));
vi.mock('../services/ShoreWatchAlarmService', () => ({ ShoreWatchAlarmService: { receivePush: vi.fn() } }));
vi.mock('../services/piNightWatchStatus', () => ({ PiNightWatchStatus: { receivePush: () => ({ hadCard: false }) } }));
vi.mock('../services/briefing/briefingPin', () => ({ pinWeatherBriefing: () => false }));
vi.mock('../utils/animationBudget', () => ({ startAnimationBudgetGuard: () => () => undefined }));
vi.mock('../services/AisShareService', () => ({ startWatch: vi.fn() }));
vi.mock('../utils/keyboardScroll', () => ({ initGlobalKeyboardScroll: () => () => undefined }));
vi.mock('../services/AisGuardWatch', () => ({ startAisGuardWatch: () => () => undefined }));
vi.mock('../services/internetProbe', () => ({ startInternetProbe: () => () => undefined }));
vi.mock('../services/InstrumentSourcePolicy', () => ({ InstrumentSourcePolicy: { boot: vi.fn() } }));
vi.mock('../services/smartPolarResume', () => ({ resumeSmartPolarsAtLaunch: vi.fn() }));
vi.mock('../services/webContentKill', () => ({ armSessionWatch: () => null, stopSessionWatch: vi.fn() }));
vi.mock('../stores/uiStore', () => ({ readLastView: () => null, sessionCrumbConsumed: vi.fn() }));
vi.mock('../services/memoryCensus', () => ({ readLastCensus: () => null, startCensus: vi.fn() }));
vi.mock('../services/gpsWarmUp', () => ({ warmUpGps: vi.fn() }));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) } }));
vi.mock('../services/alarms/wakeCloudAlarms', () => ({ refreshWakeCloudAlarms: f.wakeRefresh }));
vi.mock('../services/radar/radarPush', () => ({ refreshRadarAlarmPush: f.radarRefresh }));

import { useAppBootstrap } from '../hooks/useAppBootstrap';
import { PushToast, pushForegroundToast } from '../components/PushToast';
import { PushNotificationService } from '../services/PushNotificationService';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { createPrivateMessageCutoverPolicy } from '../services/chat/e2ee/privateMessageCutover';
import { peekOfficialPushPin, takeOfficialPushPin } from '../services/officialPushPin';

const owner = 'reconciliation-owner';
const official = {
    notification_type: 'official_warning',
    provider: 'nws',
    identifier: 'urn:fictional:reconciled-gale-warning',
    event: 'Fallback event, not the notification title',
    basis: 'home',
    expires: '2026-10-19T04:00:00Z',
};
const notice = { title: 'Fictional Gale Warning', body: 'Fictional issuer headline\nWarnings: fictional issuer' };
const expectedPin = {
    provider: official.provider,
    identifier: official.identifier,
    title: notice.title,
    body: notice.body,
    basis: 'home',
    expires: official.expires,
};

function emit(event: string, payload: unknown) {
    const callback = f.callbacks.get(event);
    if (!callback) throw new Error('Expected installed native callback');
    callback(payload);
}
function receive(data: Record<string, unknown>, title = 'Foreground fixture', body = 'Fictional fixture body') {
    emit('pushNotificationReceived', { title, body, data });
}
function tap(data: Record<string, unknown>, words: { title?: unknown; body?: unknown } = notice) {
    emit('pushNotificationActionPerformed', { notification: { ...words, data } });
}
function requireNative() {
    expect(f.policy!.requireNativePrivateMessagesForScope(getAuthIdentityScope())).toBe(true);
}
async function startBootstrap() {
    const bound = vi.spyOn(PushNotificationService, 'bindNotificationHandlers');
    const hook = renderHook(() => useAppBootstrap());
    await vi.waitFor(() => expect(bound).toHaveBeenCalledOnce());
    return { ...hook, bound };
}
async function settleImports() {
    await act(async () => vi.dynamicImportSettled());
}

beforeEach(async () => {
    vi.clearAllMocks();
    await PushNotificationService.clearUser();
    await PushNotificationService.dispose();
    f.callbacks.clear();
    setAuthIdentityScope(null);
    setAuthIdentityScope(owner);
    f.policy = createPrivateMessageCutoverPolicy(getAuthIdentityScope);
    takeOfficialPushPin();
    f.wakeRefresh.mockResolvedValue(undefined);
    f.addListener.mockImplementation((event: string, callback: (payload: unknown) => void) => {
        f.callbacks.set(event, callback);
        return Promise.resolve({ remove: vi.fn(async () => undefined) });
    });
    await PushNotificationService.initialize();
    await PushNotificationService.setUser(owner);
});
afterEach(async () => {
    cleanup();
    await settleImports();
    await PushNotificationService.clearUser();
    await PushNotificationService.dispose();
    takeOfficialPushPin();
    setAuthIdentityScope(null);
    vi.restoreAllMocks();
});

describe('E2EE / upstream push reconciliation', () => {
    it('carries the native official notification words in immutable callback snapshots', () => {
        const onNotificationTap = vi.fn();
        PushNotificationService.bindNotificationHandlers(getAuthIdentityScope(), {
            onForegroundPush: vi.fn(),
            onNotificationTap,
        });
        const mutableData = { ...official };
        tap(mutableData);
        mutableData.identifier = 'changed-after-dispatch';
        expect(onNotificationTap).toHaveBeenCalledExactlyOnceWith(official, notice);
        const [data, words] = onNotificationTap.mock.calls[0];
        expect(Object.isFrozen(data)).toBe(true);
        expect(Object.isFrozen(words)).toBe(true);
        expect(data).not.toBe(mutableData);
        expect(words).not.toBe(notice);
    });

    it('does not turn malformed native title/body values into official warning text', () => {
        const onNotificationTap = vi.fn();
        PushNotificationService.bindNotificationHandlers(getAuthIdentityScope(), {
            onForegroundPush: vi.fn(),
            onNotificationTap,
        });
        tap(official, { title: 123, body: { toString: () => 'not notification text' } });
        expect(onNotificationTap).toHaveBeenCalledExactlyOnceWith(official, { title: undefined, body: undefined });
    });

    it('pins the native official warning words before bootstrap navigation even after private cutover', async () => {
        requireNative();
        await startBootstrap();
        const pinsWhenRouting: unknown[] = [];
        f.setPage.mockImplementation((page: string) => {
            if (page === 'warnings') pinsWhenRouting.push(peekOfficialPushPin());
        });
        act(() => tap(official));
        expect(f.setPage).toHaveBeenCalledExactlyOnceWith('warnings');
        expect(pinsWhenRouting).toEqual([expectedPin]);
        expect(takeOfficialPushPin()).toEqual(expectedPin);
    });

    it('keeps foreground official pinning ahead of the toast routing callback after private cutover', () => {
        requireNative();
        const pinsWhenRouting: unknown[] = [];
        const onTap = vi.fn(() => pinsWhenRouting.push(peekOfficialPushPin()));
        render(<PushToast onTap={onTap} />);
        PushNotificationService.bindNotificationHandlers(getAuthIdentityScope(), {
            onForegroundPush: pushForegroundToast,
            onNotificationTap: vi.fn(),
        });
        act(() => receive(official, notice.title, notice.body));
        expect(peekOfficialPushPin()).toBeNull();
        fireEvent.click(screen.getByText(notice.title));
        expect(onTap).toHaveBeenCalledExactlyOnceWith(official);
        expect(pinsWhenRouting).toEqual([expectedPin]);
    });

    it('preserves wake refresh and radar-only refresh semantics while private notifications stay denied', async () => {
        requireNative();
        render(<PushToast />);
        await startBootstrap();
        const wake = { notification_type: 'wake_alarm', ruleId: 'fictional-rule' };
        const radar = { notification_type: 'radar_alarm', key: 'fictional-radar-key' };
        act(() => {
            receive({ notification_type: 'dm' }, 'Denied private DM');
            receive({ notification_type: 'hail' }, 'Denied private hail');
            tap({ notification_type: 'dm' });
            tap({ notification_type: 'hail' });
            receive(wake, 'Fictional Wake Alarm');
            receive(radar, 'Fictional Radar Alarm');
        });
        await settleImports();
        expect(screen.queryByText('Denied private DM')).toBeNull();
        expect(screen.queryByText('Denied private hail')).toBeNull();
        expect(screen.getByText('Fictional Wake Alarm')).toBeTruthy();
        expect(screen.queryByText('Fictional Radar Alarm')).toBeNull();
        expect(f.wakeRefresh).toHaveBeenCalledExactlyOnceWith();
        expect(f.radarRefresh).toHaveBeenCalledExactlyOnceWith(radar);
        expect(f.setPage).not.toHaveBeenCalled();
        act(() => {
            tap(wake);
            tap(radar);
        });
        await settleImports();
        expect(f.wakeRefresh).toHaveBeenCalledTimes(2);
        expect(f.radarRefresh.mock.calls).toEqual([[radar], [radar, true]]);
        expect(f.setPage.mock.calls).toEqual([['map'], ['map']]);
    });

    it('retains current-only lightning presentation and navigation without reopening private push', async () => {
        requireNative();
        render(<PushToast />);
        await startBootstrap();
        const now = Date.now();
        const current = {
            notification_type: 'lightning_nearby',
            provider: 'xweather',
            pulse_id: 'fictional-pulse',
            source_at: now,
            expires_at: now + 60000,
        };
        const stale = { ...current, source_at: now - 600000, expires_at: now - 300000 };
        act(() => {
            receive(stale, 'Stale fictional lightning');
            receive({ notification_type: 'dm' }, 'Still denied private DM');
        });
        expect(screen.queryByText('Stale fictional lightning')).toBeNull();
        expect(screen.queryByText('Still denied private DM')).toBeNull();
        act(() => receive(current, 'Current fictional lightning'));
        expect(screen.getByText('Current fictional lightning')).toBeTruthy();
        act(() => tap(current));
        expect(f.setPage).toHaveBeenCalledExactlyOnceWith('map');
        expect(f.wakeRefresh).not.toHaveBeenCalled();
        expect(f.radarRefresh).not.toHaveBeenCalled();
    });

    it('suppresses stale native and cached callbacks across exact account ABA without reviving private push', async () => {
        const onForegroundPush = vi.fn();
        const onNotificationTap = vi.fn();
        const handlers = { onForegroundPush, onNotificationTap };
        PushNotificationService.bindNotificationHandlers(getAuthIdentityScope(), handlers);
        const oldForeground = PushNotificationService.onForegroundPush!;
        const oldTap = PushNotificationService.onNotificationTap!;
        requireNative();
        setAuthIdentityScope('other-reconciliation-owner');
        setAuthIdentityScope(owner);
        await PushNotificationService.setUser(owner);
        for (const notification_type of ['official_warning', 'wake_alarm', 'radar_alarm', 'dm', 'hail']) {
            receive({ notification_type });
            tap({ notification_type });
            oldForeground({ title: 'Stale callback', data: { notification_type } });
            oldTap({ notification_type }, notice);
        }
        expect(onForegroundPush).not.toHaveBeenCalled();
        expect(onNotificationTap).not.toHaveBeenCalled();
        PushNotificationService.bindNotificationHandlers(getAuthIdentityScope(), handlers);
        for (const notification_type of ['official_warning', 'wake_alarm', 'radar_alarm', 'dm', 'hail']) {
            receive({ notification_type });
            tap({ notification_type });
        }
        expect(onForegroundPush.mock.calls.map(([value]) => value.data.notification_type)).toEqual([
            'official_warning',
            'wake_alarm',
            'radar_alarm',
        ]);
        expect(onNotificationTap.mock.calls.map(([data]) => data.notification_type)).toEqual([
            'official_warning',
            'wake_alarm',
            'radar_alarm',
        ]);
    });

    it('rejects wake/radar lazy refreshes queued before a synchronous exact-scope change', async () => {
        await startBootstrap();
        act(() => {
            receive({ notification_type: 'wake_alarm' });
            receive({ notification_type: 'radar_alarm' });
            tap({ notification_type: 'wake_alarm' });
            tap({ notification_type: 'radar_alarm' });
            setAuthIdentityScope('other-reconciliation-owner');
            setAuthIdentityScope(owner);
        });
        await settleImports();
        expect(f.wakeRefresh).not.toHaveBeenCalled();
        expect(f.radarRefresh).not.toHaveBeenCalled();
        // These synchronous taps were current when dispatched; no claim is
        // made that the subsequent identity change can undo that navigation.
        expect(f.setPage.mock.calls).toEqual([['map'], ['map']]);
    });
});
