// @vitest-environment node
/** Local adapter evidence only. No App mount, SDK/native/provider execution,
 * encrypted/durable storage, network or physical-device acceptance is proved.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createFullAppMemoryBoundary,
    DATA_CACHE_KEY,
    FULL_APP_MEMORY_COUNTER_LIMIT,
    FULL_APP_MEMORY_MAX_ENTRIES,
    FULL_APP_MEMORY_MAX_TOTAL_BYTES,
    FULL_APP_MEMORY_MAX_VALUE_BYTES,
    FullAppMemoryUnavailableError,
    HISTORY_CACHE_KEY,
    VOYAGE_CACHE_KEY,
} from '../experiments/scuttlebutt-e2ee/full-app-pilot/boundaryMemory';
import {
    createFullAppStartupBoundaries,
    FULL_APP_BOUNDARY_COUNTER_LIMIT,
    FULL_APP_BOUNDARY_UNAVAILABLE,
    FullAppBoundaryUnavailableError,
} from '../experiments/scuttlebutt-e2ee/full-app-pilot/boundaries';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const memoryFailure = {
    name: 'FullAppMemoryUnavailableError',
    code: 'full-app-research-memory-unavailable',
    message: 'Full app Research memory storage is unavailable.',
};
const boundaryFailure = {
    name: 'FullAppBoundaryUnavailableError',
    code: 'full-app-research-unavailable',
    message: FULL_APP_BOUNDARY_UNAVAILABLE,
};

describe('isolated full-App volatile storage adapter', () => {
    it('preserves exact existing nativeStorage cache constants without evaluating native storage', () => {
        const source = readFileSync(new URL('../services/nativeStorage.ts', import.meta.url), 'utf8');
        for (const [name, value] of Object.entries({ DATA_CACHE_KEY, VOYAGE_CACHE_KEY, HISTORY_CACHE_KEY })) {
            expect(source).toContain(`export const ${name} = '${value}'`);
        }
    });

    it('settles Preferences reads/writes/removals/clear within its own memory only', async () => {
        const first = createFullAppMemoryBoundary();
        const second = createFullAppMemoryBoundary();
        await expect(first.Preferences.get({ key: 'settings' })).resolves.toEqual({ value: null });
        await first.Preferences.set({ key: 'settings', value: 'local-fixture-only' });
        await expect(first.Preferences.get({ key: 'settings' })).resolves.toEqual({ value: 'local-fixture-only' });
        await expect(second.Preferences.get({ key: 'settings' })).resolves.toEqual({ value: null });
        const keys = await first.Preferences.keys();
        expect(keys).toEqual({ keys: ['settings'] });
        keys.keys.push('caller-only');
        expect(await first.Preferences.keys()).toEqual({ keys: ['settings'] });
        await first.Preferences.remove({ key: 'settings' });
        expect(await first.Preferences.get({ key: 'settings' })).toEqual({ value: null });
        await first.Preferences.set({ key: 'settings', value: 'memory' });
        await first.Preferences.clear();
        expect(await first.Preferences.keys()).toEqual({ keys: [] });
    });

    it('serializes input and independently copies every cache read', async () => {
        const { nativeStorage } = createFullAppMemoryBoundary();
        const input = { nested: { name: 'original' }, rows: [1] };
        const pending = nativeStorage.saveLargeData(DATA_CACHE_KEY, input);
        input.nested.name = 'caller-changed';
        input.rows.push(2);
        await pending;
        const first = (await nativeStorage.loadLargeData(DATA_CACHE_KEY)) as typeof input;
        expect(first).toEqual({ nested: { name: 'original' }, rows: [1] });
        first.nested.name = 'read-changed';
        expect(nativeStorage.loadLargeDataSync(DATA_CACHE_KEY)).toEqual({ nested: { name: 'original' }, rows: [1] });
        await nativeStorage.deleteLargeData(DATA_CACHE_KEY);
        expect(await nativeStorage.loadLargeData(DATA_CACHE_KEY)).toBeNull();
    });

    it('settles save/flush/version gates immediately without debounce timers or fabricated native encryption', async () => {
        const timer = vi.spyOn(globalThis, 'setTimeout');
        const interval = vi.spyOn(globalThis, 'setInterval');
        const { nativeStorage } = createFullAppMemoryBoundary();
        let settled = false;
        void nativeStorage.saveLargeData('fixture', { available: false }).then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(true);
        await nativeStorage.flushPendingSaves();
        expect(await nativeStorage.readCacheVersion()).toBeNull();
        await nativeStorage.writeCacheVersion('fixture-version');
        expect(await nativeStorage.readCacheVersion()).toBe('fixture-version');
        await nativeStorage.saveLargeDataImmediate('thalassa_cache_version', { separate: true });
        expect(await nativeStorage.readCacheVersion()).toBe('fixture-version');
        expect(await nativeStorage.loadLargeData('thalassa_cache_version')).toEqual({ separate: true });
        expect(nativeStorage.usesNativeEncryptedLargeStorage()).toBe(false);
        expect(nativeStorage.isAllowedEncryptedLargeStorageKey(DATA_CACHE_KEY)).toBe(false);
        expect(timer).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
    });

    it.each(['configure', 'migrate', 'removeOld'] as const)(
        'refuses native Preferences %s instead of claiming a migration',
        async (method) => {
            await expect(createFullAppMemoryBoundary().Preferences[method]()).rejects.toMatchObject(memoryFailure);
        },
    );

    it.each(['', 'bad\u0000key', 'x'.repeat(4_097)])(
        'refuses malformed memory keys without preserving their contents',
        async (key) => {
            const memory = createFullAppMemoryBoundary();
            await expect(memory.Preferences.set({ key, value: 'private-value-canary' })).rejects.toMatchObject(
                memoryFailure,
            );
            await expect(
                memory.nativeStorage.saveLargeData(key, { secret: 'private-value-canary' }),
            ).rejects.toMatchObject(memoryFailure);
            expect(await memory.Preferences.keys()).toEqual({ keys: [] });
            expect(JSON.stringify(memory.readCounters())).not.toContain('private-value-canary');
        },
    );

    it('refuses throwing input/serialization getters with fixed errors and no raw diagnostics', async () => {
        const memory = createFullAppMemoryBoundary();
        const getter = vi.fn(() => {
            throw new Error('credential-and-message-canary');
        });
        const options = Object.defineProperty({}, 'key', { get: getter });
        const data = Object.defineProperty({}, 'secret', { enumerable: true, get: getter });
        await expect(memory.Preferences.get(options as { key: string })).rejects.toMatchObject(memoryFailure);
        await expect(memory.nativeStorage.saveLargeData('fixture', data)).rejects.toMatchObject(memoryFailure);
        expect(memory.readCounters().refusals).toBe(2);
        expect(JSON.stringify(memory.readCounters())).not.toContain('credential-and-message-canary');
        expect(await memory.nativeStorage.loadLargeData('fixture')).toBeNull();
    });

    it('refuses unserializable cache data and preserves a previous accepted entry', async () => {
        const { nativeStorage } = createFullAppMemoryBoundary();
        await nativeStorage.saveLargeData('fixture', { original: true });
        const circular: { self?: unknown } = {};
        circular.self = circular;
        for (const value of [undefined, circular, 1n]) {
            await expect(nativeStorage.saveLargeData('fixture', value)).rejects.toMatchObject(memoryFailure);
            expect(await nativeStorage.loadLargeData('fixture')).toEqual({ original: true });
        }
    });

    it('enforces entry capacity transactionally and frees only its own removed entry', async () => {
        const memory = createFullAppMemoryBoundary();
        for (let index = 0; index < FULL_APP_MEMORY_MAX_ENTRIES; index += 1) {
            await memory.Preferences.set({ key: `fixture-${index}`, value: 'local' });
        }
        await memory.Preferences.set({ key: 'fixture-0', value: 'replacement' });
        await expect(memory.Preferences.set({ key: 'overflow', value: 'secret' })).rejects.toMatchObject(memoryFailure);
        expect((await memory.Preferences.keys()).keys).toHaveLength(FULL_APP_MEMORY_MAX_ENTRIES);
        expect(await memory.Preferences.get({ key: 'fixture-0' })).toEqual({ value: 'replacement' });
        await memory.Preferences.remove({ key: 'fixture-1' });
        await memory.Preferences.set({ key: 'next-fixture', value: 'local' });
        expect((await memory.Preferences.keys()).keys).toHaveLength(FULL_APP_MEMORY_MAX_ENTRIES);
    });

    it('bounds bytes per value and per store, without replacing an accepted value on refusal', async () => {
        const memory = createFullAppMemoryBoundary();
        const value = 'a'.repeat(FULL_APP_MEMORY_MAX_VALUE_BYTES);
        const slots = FULL_APP_MEMORY_MAX_TOTAL_BYTES / FULL_APP_MEMORY_MAX_VALUE_BYTES;
        for (let index = 0; index < slots; index += 1) {
            await memory.Preferences.set({ key: `fixture-${index}`, value });
        }
        await expect(memory.Preferences.set({ key: 'overflow', value: 'b' })).rejects.toMatchObject(memoryFailure);
        await expect(memory.Preferences.set({ key: 'fixture-0', value: `${value}b` })).rejects.toMatchObject(
            memoryFailure,
        );
        expect((await memory.Preferences.get({ key: 'fixture-0' })).value).toBe(value);
        await memory.Preferences.remove({ key: 'fixture-1' });
        await memory.Preferences.set({ key: 'next-fixture', value: 'b' });
    });

    it('exposes only immutable, bounded numeric diagnostics', async () => {
        const memory = createFullAppMemoryBoundary();
        const original = memory.readCounters();
        for (let index = 0; index <= FULL_APP_MEMORY_COUNTER_LIMIT; index += 1) {
            await memory.Preferences.get({ key: 'private-key-canary' });
        }
        expect(original.preferenceReads).toBe(0);
        expect(memory.readCounters().preferenceReads).toBe(FULL_APP_MEMORY_COUNTER_LIMIT);
        expect(Object.isFrozen(memory.readCounters())).toBe(true);
        expect(Object.values(memory.readCounters()).every((value) => Number.isSafeInteger(value))).toBe(true);
        expect(JSON.stringify(memory.readCounters())).not.toContain('private-key-canary');
        expect(new FullAppMemoryUnavailableError()).toMatchObject(memoryFailure);
    });
});

describe('fixed denied full-App startup/native leaves', () => {
    it('has no runtime imports or storage/transport/timer implementation in either adapter source', () => {
        for (const file of ['boundaries.ts', 'boundaryMemory.ts']) {
            const source = readFileSync(
                new URL(`../experiments/scuttlebutt-e2ee/full-app-pilot/${file}`, import.meta.url),
                'utf8',
            );
            expect(source).not.toMatch(/^\s*import\s/m);
            expect(source).not.toMatch(
                /(?:registerPlugin|fetch|setTimeout|setInterval|localStorage|sessionStorage|indexedDB)\s*\(/,
            );
        }
    });

    it('returns honest idle/null/unavailable projections with no active owner, position, connection or memory reading', async () => {
        const leaves = createFullAppStartupBoundaries();
        expect(leaves.InstrumentSourcePolicy.boot()).toBe('idle');
        expect(leaves.InstrumentSourcePolicy.ensureFeed({ host: 'private-host-canary' })).toBe('none');
        expect(leaves.InstrumentSourcePolicy.mode()).toBe('none');
        expect(leaves.AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'idle',
            anchorPosition: null,
            vesselPosition: null,
            gpsQuality: 'degraded',
            setupError: FULL_APP_BOUNDARY_UNAVAILABLE,
        });
        expect(leaves.AnchorWatchSyncService.getState()).toMatchObject({
            connected: false,
            peerConnected: false,
            sessionCode: null,
        });
        expect(leaves.AnchorWatchSyncService.getLatestBroadcast()).toBeNull();
        expect(leaves.AnchorWatchSyncService.getLatestPosition()).toBeNull();
        expect(await leaves.AnchorWatchSyncService.refreshPushReadiness()).toEqual({
            status: 'unavailable',
            reason: FULL_APP_BOUNDARY_UNAVAILABLE,
            checkedAt: null,
        });
        expect(leaves.ShipLogService.getPublishedTrackingStatus()).toEqual({
            isTracking: false,
            isPaused: false,
            isRapidMode: false,
        });
        expect(leaves.ShipLogService.getGpsStatus()).toBe('none');
        expect(leaves.ShipLogService.getGpsNavData()).toEqual({ sogKts: null, cogDeg: null });
        expect(leaves.piCache.getStatus().reachable).toBe(false);
        expect(leaves.piCache.getBaseUrl()).toBeNull();
        expect(leaves.getLocalDatabaseIdentity()).toBeNull();
        expect(leaves.isLocalDatabaseSessionCurrent(leaves.getLocalDatabaseSession())).toBe(false);
        expect(leaves.getSyncStatus()).toBe('offline');
        expect(await leaves.refreshAvailableMemory()).toBeNull();
        expect(leaves.recentAvailableMemory()).toBeNull();
        expect(leaves.getShareStats()).toMatchObject({ link: 'down', lastFlushOk: null, card: null });
    });

    it('settles every GPS API with null and never invokes a location callback', async () => {
        const leaves = createFullAppStartupBoundaries();
        const location = vi.fn();
        expect(await leaves.GpsService.getCurrentPosition()).toBeNull();
        expect(await leaves.GpsService.getCurrentPositionIfGranted()).toBeNull();
        expect(await leaves.GpsService.requestCurrentForegroundPosition()).toBeNull();
        expect(leaves.GpsService.getLastKnownPosition()).toBeNull();
        expect(leaves.canUseForegroundHighAccuracy({ location: 'granted' }, true)).toBe(false);
        const stop = leaves.GpsService.watchPosition(location);
        stop();
        stop();
        expect(location).not.toHaveBeenCalled();
        expect(leaves.readCounters().cleanups).toBe(1);
    });

    it('refuses the anchor distance helper without returning geometry or inspecting argument getters', () => {
        const leaves = createFullAppStartupBoundaries();
        const getter = vi.fn(() => {
            throw new Error('Distance arguments must not be inspected');
        });
        const argument = new Proxy({}, { get: getter });
        expect(() => leaves.haversineDistance(argument, argument, argument, argument)).toThrowError(
            FullAppBoundaryUnavailableError,
        );
        expect(() => leaves.haversineDistance(0, 0, 0, 0)).toThrowError(FullAppBoundaryUnavailableError);
        expect(getter).not.toHaveBeenCalled();
        expect(leaves.readCounters().anchorRequests).toBe(2);
    });

    it('settles background GPS presentation with absent fixes and unknown unusable health', async () => {
        const manager = createFullAppStartupBoundaries().BgGeoManager;
        const getter = vi.fn(() => {
            throw new Error('Background GPS options must not be inspected');
        });
        const options = new Proxy({}, { get: getter });
        expect(manager.getLastPosition(options)).toBeNull();
        expect(manager.getLastGpsHealth(options)).toBeNull();
        expect(await manager.getFreshPosition(options)).toBeNull();
        const health = await manager.getGpsHealth(options);
        expect(health).toEqual({ usable: false, reason: 'unknown', actionable: false });
        expect(Object.isFrozen(health)).toBe(true);
        expect(await manager.isNativeTrackingEnabled(options)).toBe(false);
        expect(await manager.tryRemoveGeofence(options)).toBe(false);
        expect(getter).not.toHaveBeenCalled();
        expect(Object.isFrozen(manager)).toBe(true);
    });

    it('refuses every strict background GPS control/state read without inspecting input or scheduling I/O', async () => {
        const manager = createFullAppStartupBoundaries().BgGeoManager;
        const getter = vi.fn(() => {
            throw new Error('Background GPS options must not be inspected');
        });
        const options = new Proxy({}, { get: getter });
        const fetch = vi.fn(() => {
            throw new Error('Unexpected fixture transport');
        });
        vi.stubGlobal('fetch', fetch);
        const timeout = vi.spyOn(globalThis, 'setTimeout');
        const interval = vi.spyOn(globalThis, 'setInterval');
        const controls = [
            manager.ensureReady,
            manager.requireAlwaysLocationAuthorization,
            manager.requestStart,
            manager.revalidateExistingLease,
            manager.requestStop,
            manager.forceStop,
            manager.getNativeTrackingEnabledStrict,
            manager.getLeaseState,
            manager.setSamplingMode,
            manager.restoreSamplingModeIfCurrent,
            manager.addGeofence,
            manager.geofenceExists,
            manager.removeGeofence,
        ];
        for (const control of controls) await expect(control(options)).rejects.toMatchObject(boundaryFailure);
        expect(getter).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(timeout).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
    });

    it('keeps every background GPS subscription callback silent and its cleanup idempotent', () => {
        const leaves = createFullAppStartupBoundaries();
        const callback = vi.fn();
        const timeout = vi.spyOn(globalThis, 'setTimeout');
        const interval = vi.spyOn(globalThis, 'setInterval');
        for (const subscribe of [
            leaves.BgGeoManager.subscribeGpsHealth,
            leaves.BgGeoManager.subscribeLocation,
            leaves.BgGeoManager.subscribeGeofence,
            leaves.BgGeoManager.subscribeHeartbeat,
        ]) {
            const stop = subscribe(callback);
            stop();
            stop();
        }
        expect(callback).not.toHaveBeenCalled();
        expect(leaves.readCounters()).toMatchObject({ subscriptions: 4, cleanups: 4 });
        expect(timeout).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
    });

    it('keeps startup/cleanup requests inert without invoking supplied setup callbacks or scheduling I/O', () => {
        const fetch = vi.fn(() => {
            throw new Error('unexpected-browser-network');
        });
        vi.stubGlobal('fetch', fetch);
        const timeout = vi.spyOn(globalThis, 'setTimeout');
        const interval = vi.spyOn(globalThis, 'setInterval');
        const leaves = createFullAppStartupBoundaries();
        const subscribe = vi.fn();
        leaves.AnchorPiPush.start(subscribe);
        leaves.piCache.boot({ piCacheEnabled: true });
        leaves.startWatch();
        leaves.startSyncEngine();
        leaves.stopSyncEngine();
        const stop = leaves.startInternetProbe();
        stop();
        leaves.stopInternetProbe();
        expect(subscribe).not.toHaveBeenCalled();
        expect(timeout).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('publishes only fixed one-shot snapshots, ignores observer exceptions and retains no later events', () => {
        const leaves = createFullAppStartupBoundaries();
        const anchor = vi.fn();
        const sync = vi.fn();
        const push = vi.fn();
        const pi = vi.fn();
        const broadcast = vi.fn();
        const stop = leaves.AnchorWatchService.subscribe(anchor);
        leaves.AnchorWatchSyncService.onStateChange(sync);
        leaves.AnchorWatchSyncService.onPushReadinessChange(push);
        leaves.piCache.onStatusChange(pi);
        leaves.AnchorWatchSyncService.onBroadcast(broadcast);
        expect(anchor).toHaveBeenCalledWith(leaves.AnchorWatchService.getSnapshot());
        expect(sync).toHaveBeenCalledWith(leaves.AnchorWatchSyncService.getState());
        expect(push).toHaveBeenCalledWith(leaves.AnchorWatchSyncService.getPushReadiness());
        expect(pi).toHaveBeenCalledWith(leaves.piCache.getStatus());
        expect(broadcast).not.toHaveBeenCalled();
        expect(() =>
            leaves.AnchorWatchService.subscribe(() => {
                throw new Error('private-observer-canary');
            }),
        ).not.toThrow();
        stop();
        stop();
        expect(anchor).toHaveBeenCalledTimes(1);
        expect(Object.isFrozen(leaves.AnchorWatchService.getSnapshot())).toBe(true);
        expect(JSON.stringify(leaves.readCounters())).not.toContain('private-observer-canary');
    });

    it('refuses all transport/native-control methods without inspecting supplied getters or retaining arguments', async () => {
        const leaves = createFullAppStartupBoundaries();
        const getter = vi.fn(() => {
            throw new Error('credential-message-canary');
        });
        const options = new Proxy({}, { get: getter });
        const calls = [
            leaves.CapacitorHttp.request,
            leaves.CapacitorHttp.get,
            leaves.CapacitorHttp.post,
            leaves.CapacitorHttp.put,
            leaves.CapacitorHttp.patch,
            leaves.CapacitorHttp.delete,
            leaves.KeepAwake.keepAwake,
            leaves.KeepAwake.allowSleep,
            leaves.KeepAwake.isKeptAwake,
            leaves.ScreenOrientation.lock,
            leaves.ScreenOrientation.unlock,
            leaves.ScreenOrientation.orientation,
            leaves.ScreenOrientation.addListener,
            leaves.ScreenOrientation.removeAllListeners,
            leaves.PushNotifications.register,
            leaves.PushNotifications.unregister,
            leaves.PushNotifications.addListener,
            leaves.PushNotifications.removeAllListeners,
            leaves.PushNotifications.getDeliveredNotifications,
            leaves.PushNotifications.removeDeliveredNotifications,
            leaves.PushNotifications.removeAllDeliveredNotifications,
            leaves.piCache.fetch,
            leaves.piCache.passthroughJson,
            leaves.piCache.passthroughText,
            leaves.piCache.passthroughTileResponse,
            leaves.piCache.ping,
        ];
        for (const call of calls) await expect(call(options)).rejects.toMatchObject(boundaryFailure);
        expect(getter).not.toHaveBeenCalled();
        expect(await leaves.PushNotifications.checkPermissions()).toEqual({ receive: 'denied' });
        expect(await leaves.PushNotifications.requestPermissions()).toEqual({ receive: 'denied' });
        expect(await leaves.KeepAwake.isSupported()).toEqual({ isSupported: false });
        expect(JSON.stringify(leaves.readCounters())).not.toContain('credential-message-canary');
        expect(new FullAppBoundaryUnavailableError()).toMatchObject(boundaryFailure);
    });

    it('refuses vessel/Apple/monitor mutations and does not execute transaction/setup functions', async () => {
        const leaves = createFullAppStartupBoundaries();
        const operation = vi.fn();
        const calls = [
            leaves.initLocalDatabase,
            leaves.deltaLocal,
            leaves.atomicLocalTransaction,
            leaves.insertLocal,
            leaves.updateLocal,
            leaves.deleteLocal,
            leaves.bulkUpsert,
            leaves.updateSyncMeta,
            leaves.purgeLocalDatabaseForUser,
            leaves.requestFullReconciliation,
            leaves.syncNow,
            leaves.forceFullPull,
            leaves.bindAppleCredentialUser,
            leaves.clearBoundAppleCredential,
            leaves.startAppleCredentialRevocationMonitoring,
            leaves.warmUpGps,
            leaves.ShipLogService.initialize,
            leaves.ShipLogService.startTracking,
            leaves.AnchorWatchService.restoreWatchState,
            leaves.AnchorWatchService.acknowledgeAlarm,
            leaves.writeAnchorPiConfig,
            leaves.clearAnchorPiConfig,
        ];
        for (const call of calls) await expect(call(operation)).rejects.toMatchObject(boundaryFailure);
        expect(operation).not.toHaveBeenCalled();
        expect(() => leaves.piCache.configure({ enabled: true })).toThrow(FullAppBoundaryUnavailableError);
        expect(() => leaves.setShareEnabled(true)).toThrow(FullAppBoundaryUnavailableError);
        expect(await leaves.AnchorWatchSyncService.restoreSession()).toBe(false);
        expect(await leaves.AnchorWatchSyncService.createSession()).toBeNull();
        expect(await leaves.AnchorWatchSyncService.joinSession('private-code')).toBe(false);
        expect(await leaves.AnchorPiWatchKeeper.begin({ sessionCode: 'private-code' })).toBe(false);
        expect(await leaves.AnchorPiWatchKeeper.renewNow()).toBe(false);
        expect(await leaves.probePiWatchCapability()).toEqual({
            capable: false,
            hasFix: false,
            reason: FULL_APP_BOUNDARY_UNAVAILABLE,
        });
        expect(await leaves.piCache.setDiaryRelayInternetPolicy(true)).toBe(false);
        expect(JSON.stringify(leaves.readCounters())).not.toContain('private-code');
    });

    it('returns immutable bounded numeric counters independent of another composition', () => {
        const first = createFullAppStartupBoundaries();
        const second = createFullAppStartupBoundaries();
        const original = first.readCounters();
        for (let index = 0; index <= FULL_APP_BOUNDARY_COUNTER_LIMIT; index += 1) first.InstrumentSourcePolicy.boot();
        expect(original.instrumentRequests).toBe(0);
        expect(first.readCounters().instrumentRequests).toBe(FULL_APP_BOUNDARY_COUNTER_LIMIT);
        expect(second.readCounters().instrumentRequests).toBe(0);
        expect(Object.isFrozen(first.readCounters())).toBe(true);
        expect(
            Object.values(first.readCounters()).every(
                (value) => Number.isSafeInteger(value) && value <= FULL_APP_BOUNDARY_COUNTER_LIMIT,
            ),
        ).toBe(true);
    });
});
