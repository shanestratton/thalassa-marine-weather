/** Fixed isolated startup/native leaves. No production module/native singleton,
 * SDK, browser storage, timer or transport is imported here. Idle projections
 * grant no monitoring, persistence, native readiness or successful mutation.
 * Void startup requests are discarded; control/transport requests refuse.
 */
export const FULL_APP_BOUNDARY_COUNTER_LIMIT = 1_024;
export const FULL_APP_BOUNDARY_UNAVAILABLE = 'Unavailable in full app Research.';
export const MIN_ANCHOR_SWING_RADIUS_M = 20;
/** Display vocabulary only, not a fix, location permission or anchor authority. */
export const ANCHOR_RELOCATE_FIX_MAX_AGE_MS = 30_000;
export const ANCHOR_WATCH_CONFIG_LIMITS = Object.freeze({
    rodeLength: Object.freeze({ min: 1, max: 300 }),
    waterDepth: Object.freeze({ min: 0.5, max: 100 }),
    scopeRatio: Object.freeze({ min: 1, max: 20 }),
    safetyMargin: Object.freeze({ min: 1, max: 100 }),
});
export class FullAppBoundaryUnavailableError extends Error {
    readonly code = 'full-app-research-unavailable';
    constructor() {
        super(FULL_APP_BOUNDARY_UNAVAILABLE);
        this.name = 'FullAppBoundaryUnavailableError';
    }
}
const initialCounters = () => ({
    instrumentRequests: 0,
    gpsRequests: 0,
    internetRequests: 0,
    aisRequests: 0,
    appleRequests: 0,
    anchorRequests: 0,
    anchorSyncRequests: 0,
    anchorPiRequests: 0,
    shiplogRequests: 0,
    vesselRequests: 0,
    piRequests: 0,
    nativeRequests: 0,
    observations: 0,
    subscriptions: 0,
    cleanups: 0,
});
export type FullAppBoundaryCounters = Readonly<ReturnType<typeof initialCounters>>;

/** New explicit fixture/composition only; there is no global reset or activation. */
export function createFullAppStartupBoundaries() {
    const counters = initialCounters();
    type Counter = keyof typeof counters;
    const count = (key: Counter) => {
        counters[key] = Math.min(FULL_APP_BOUNDARY_COUNTER_LIMIT, counters[key] + 1);
    };
    const denied =
        (key: Counter) =>
        (..._args: unknown[]): never => {
            count(key);
            throw new FullAppBoundaryUnavailableError();
        };
    const deniedAsync =
        (key: Counter) =>
        async (..._args: unknown[]): Promise<never> =>
            denied(key)();
    const discarded =
        (key: Counter) =>
        (..._args: unknown[]): void => {
            count(key);
        };
    const refusal =
        <T>(key: Counter, value: T) =>
        (..._args: unknown[]): T => {
            count(key);
            return value;
        };
    const refusalAsync =
        <T>(key: Counter, value: T) =>
        async (..._args: unknown[]): Promise<T> =>
            refusal(key, value)();
    const observe =
        <T>(value: T) =>
        (..._args: unknown[]): T => {
            count('observations');
            return value;
        };
    const cleanup = () => {
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            count('cleanups');
        };
    };
    const listen =
        <T>(value: T, publish = true) =>
        (listener: unknown): (() => void) => {
            count('subscriptions');
            if (publish && typeof listener === 'function') {
                try {
                    listener(value);
                } catch {
                    // Fixed observations only; never retain callback/errors/arguments.
                }
            }
            // No listener is retained, and no later/native events can be delivered.
            return cleanup();
        };
    const anchorConfig = Object.freeze({
        rodeLength: 30,
        waterDepth: 5,
        scopeRatio: 6,
        rodeType: 'chain' as const,
        safetyMargin: 10,
    });
    const anchor = Object.freeze({
        state: 'idle' as const,
        anchorPosition: null,
        vesselPosition: null,
        swingRadius: 0,
        distanceFromAnchor: 0,
        maxDistanceRecorded: 0,
        bearingToAnchor: 0,
        config: anchorConfig,
        positionHistory: Object.freeze([]),
        alarmTriggeredAt: null,
        alarmCause: null,
        watchStartedAt: null,
        gpsAccuracy: Number.POSITIVE_INFINITY,
        gpsQuality: 'degraded' as const,
        gpsQualityLabel: FULL_APP_BOUNDARY_UNAVAILABLE,
        guardianStatus: 'idle' as const,
        setupError: FULL_APP_BOUNDARY_UNAVAILABLE,
        alarmNotificationError: null,
        blindGpsReason: null,
        gpsSource: null,
    });
    const sync = Object.freeze({
        connected: false,
        role: 'vessel' as const,
        sessionCode: null,
        peerConnected: false,
        lastPeerUpdate: null,
        peerDisconnectedAt: null,
    });
    const push = Object.freeze({
        status: 'unavailable' as const,
        reason: FULL_APP_BOUNDARY_UNAVAILABLE,
        checkedAt: null,
    });
    const tracking = Object.freeze({ isTracking: false, isPaused: false, isRapidMode: false });
    const pi = Object.freeze({
        reachable: false,
        lastCheck: 0,
        latencyMs: 0,
        supabaseConfigured: false,
        diaryRelayConfigured: false,
    });
    const stats = Object.freeze({
        buffered: 0,
        sharedTotal: 0,
        droppedTotal: 0,
        lastFlushOk: null,
        lastFlushAt: null,
        link: 'down' as const,
        linkError: FULL_APP_BOUNDARY_UNAVAILABLE,
        reconnects: 0,
        rejected: null,
        card: null,
    });

    const InstrumentSourcePolicy = Object.freeze({
        boot: refusal('instrumentRequests', 'idle' as const),
        ensureFeed: refusal('instrumentRequests', 'none' as const),
        mode: observe('none' as const),
        noteManualConnect: denied('instrumentRequests'),
        noteManualDisconnect: denied('instrumentRequests'),
        tick: discarded('instrumentRequests'),
    });
    const GpsService = Object.freeze({
        getCurrentPosition: refusalAsync('gpsRequests', null),
        getCurrentPositionIfGranted: refusalAsync('gpsRequests', null),
        requestCurrentForegroundPosition: refusalAsync('gpsRequests', null),
        getLastKnownPosition: observe(null),
        watchPosition: (..._args: unknown[]) => {
            count('gpsRequests');
            return cleanup();
        },
    });
    // No background manager/native package evaluates. Unknown health and absent
    // fixes are presentation refusals; strict state/control reads must reject.
    const gpsHealth = Object.freeze({ usable: false, reason: 'unknown' as const, actionable: false });
    const BgGeoManager = Object.freeze({
        getLastPosition: observe(null),
        getLastGpsHealth: observe(null),
        getFreshPosition: refusalAsync('gpsRequests', null),
        getGpsHealth: refusalAsync('gpsRequests', gpsHealth),
        isNativeTrackingEnabled: refusalAsync('gpsRequests', false),
        tryRemoveGeofence: refusalAsync('gpsRequests', false),
        subscribeGpsHealth: listen(null, false),
        subscribeLocation: listen(null, false),
        subscribeGeofence: listen(null, false),
        subscribeHeartbeat: listen(null, false),
        ensureReady: deniedAsync('gpsRequests'),
        requireAlwaysLocationAuthorization: deniedAsync('gpsRequests'),
        requestStart: deniedAsync('gpsRequests'),
        revalidateExistingLease: deniedAsync('gpsRequests'),
        requestStop: deniedAsync('gpsRequests'),
        forceStop: deniedAsync('gpsRequests'),
        getNativeTrackingEnabledStrict: deniedAsync('gpsRequests'),
        getLeaseState: deniedAsync('gpsRequests'),
        setSamplingMode: deniedAsync('gpsRequests'),
        restoreSamplingModeIfCurrent: deniedAsync('gpsRequests'),
        addGeofence: deniedAsync('gpsRequests'),
        geofenceExists: deniedAsync('gpsRequests'),
        removeGeofence: deniedAsync('gpsRequests'),
    });
    const AnchorWatchService = Object.freeze({
        getSnapshot: observe(anchor),
        subscribe: listen(anchor),
        restoreWatchState: deniedAsync('anchorRequests'),
        acknowledgeAlarm: deniedAsync('anchorRequests'),
        startWatch: deniedAsync('anchorRequests'),
        stopWatch: deniedAsync('anchorRequests'),
        pauseWatch: deniedAsync('anchorRequests'),
        resumeWatch: deniedAsync('anchorRequests'),
        setAnchor: refusalAsync('anchorRequests', false),
        setAnchorAt: refusalAsync('anchorRequests', false),
        updateConfig: refusalAsync('anchorRequests', false),
    });
    const AnchorWatchSyncService = Object.freeze({
        getState: observe(sync),
        onStateChange: listen(sync),
        onBroadcast: listen(null, false),
        getLatestBroadcast: observe(null),
        getLatestPosition: observe(null),
        getPushReadiness: observe(push),
        onPushReadinessChange: listen(push),
        refreshPushReadiness: refusalAsync('anchorSyncRequests', push),
        getLastSessionCode: observe(null),
        hasPersistedSession: observe(false),
        getPersistedSession: observe(null),
        restoreSession: refusalAsync('anchorSyncRequests', false),
        createSession: refusalAsync('anchorSyncRequests', null),
        joinSession: refusalAsync('anchorSyncRequests', false),
        leaveSession: deniedAsync('anchorSyncRequests'),
        sendAlarmPush: deniedAsync('anchorSyncRequests'),
        acknowledgeAlarmReminders: refusalAsync('anchorSyncRequests', false),
        broadcastPosition: denied('anchorSyncRequests'),
        broadcastAlarm: denied('anchorSyncRequests'),
    });
    const AnchorPiPush = Object.freeze({
        start: discarded('anchorPiRequests'),
        stop: discarded('anchorPiRequests'),
        offer: deniedAsync('anchorPiRequests'),
        drain: deniedAsync('anchorPiRequests'),
    });
    const AnchorPiWatchKeeper = Object.freeze({
        restore: refusal('anchorPiRequests', false),
        isKeeping: observe(false),
        keepingSessionCode: observe(null),
        begin: refusalAsync('anchorPiRequests', false),
        renewNow: refusalAsync('anchorPiRequests', false),
        end: deniedAsync('anchorPiRequests'),
    });
    const ShipLogService = Object.freeze({
        initialize: deniedAsync('shiplogRequests'),
        getCurrentVoyageId: observe(undefined),
        getTrackingStatus: observe(tracking),
        getPublishedTrackingStatus: observe(tracking),
        isTracking: observe(false),
        onTrackingStateChange: listen(false, false),
        getLastAcceptedFix: observe(null),
        getGpsStatus: observe('none' as const),
        getGpsNavData: observe(Object.freeze({ sogKts: null, cogDeg: null })),
        startTracking: deniedAsync('shiplogRequests'),
        stopTracking: deniedAsync('shiplogRequests'),
        pauseTracking: deniedAsync('shiplogRequests'),
        resumeTracking: deniedAsync('shiplogRequests'),
    });
    const piCache = Object.freeze({
        boot: discarded('piRequests'),
        configure: denied('piRequests'),
        adoptPairing: denied('piRequests'),
        awaitReady: deniedAsync('piRequests'),
        getStatus: observe(pi),
        getBaseUrl: observe(null),
        getRemoteBaseUrl: observe(null),
        isAvailable: observe(false),
        getPairableCandidate: observe(null),
        onPairingEvent: listen(null, false),
        onStatusChange: listen(pi),
        viaRemoteAccess: false,
        canReachPinned: observe(false),
        canDisplayProxiedTiles: observe(false),
        getFetchStats: observe(Object.freeze({ lastSource: null, lastPiServedAt: 0, piHits: 0, directHits: 0 })),
        setDiaryRelayInternetPolicy: refusalAsync('piRequests', false),
        unifiedWeatherUrl: observe(null),
        passthroughUrl: observe(null),
        passthroughTileUrl: observe(null),
        getBarometer: refusalAsync('piRequests', null),
        fetchRemoteAccessStatus: refusalAsync('piRequests', null),
        fetch: deniedAsync('piRequests'),
        passthroughJson: deniedAsync('piRequests'),
        passthroughText: deniedAsync('piRequests'),
        passthroughTileResponse: deniedAsync('piRequests'),
        ping: deniedAsync('piRequests'),
        discover: deniedAsync('piRequests'),
        pushConfig: deniedAsync('piRequests'),
        enableRemoteAccess: deniedAsync('piRequests'),
        disableRemoteAccess: deniedAsync('piRequests'),
        purgeCache: deniedAsync('piRequests'),
        updateLocation: denied('piRequests'),
        tileUrl: denied('piRequests'),
        leafletTileTemplate: denied('piRequests'),
    });
    const KeepAwake = Object.freeze({
        keepAwake: deniedAsync('nativeRequests'),
        allowSleep: deniedAsync('nativeRequests'),
        isSupported: refusalAsync('nativeRequests', Object.freeze({ isSupported: false })),
        isKeptAwake: deniedAsync('nativeRequests'),
    });
    const ScreenOrientation = Object.freeze({
        lock: deniedAsync('nativeRequests'),
        unlock: deniedAsync('nativeRequests'),
        orientation: deniedAsync('nativeRequests'),
        addListener: deniedAsync('nativeRequests'),
        removeAllListeners: deniedAsync('nativeRequests'),
    });
    const PushNotifications = Object.freeze({
        checkPermissions: refusalAsync('nativeRequests', Object.freeze({ receive: 'denied' as const })),
        requestPermissions: refusalAsync('nativeRequests', Object.freeze({ receive: 'denied' as const })),
        register: deniedAsync('nativeRequests'),
        unregister: deniedAsync('nativeRequests'),
        addListener: deniedAsync('nativeRequests'),
        removeAllListeners: deniedAsync('nativeRequests'),
        getDeliveredNotifications: deniedAsync('nativeRequests'),
        removeDeliveredNotifications: deniedAsync('nativeRequests'),
        removeAllDeliveredNotifications: deniedAsync('nativeRequests'),
    });
    const CapacitorHttp = Object.freeze({
        request: deniedAsync('nativeRequests'),
        get: deniedAsync('nativeRequests'),
        post: deniedAsync('nativeRequests'),
        put: deniedAsync('nativeRequests'),
        patch: deniedAsync('nativeRequests'),
        delete: deniedAsync('nativeRequests'),
    });

    return Object.freeze({
        InstrumentSourcePolicy,
        GpsService,
        BgGeoManager,
        AnchorWatchService,
        AnchorWatchSyncService,
        AnchorPiPush,
        AnchorPiWatchKeeper,
        ShipLogService,
        piCache,
        KeepAwake,
        ScreenOrientation,
        PushNotifications,
        CapacitorHttp,
        warmUpGps: deniedAsync('gpsRequests'),
        startInternetProbe: (..._args: unknown[]) => {
            count('internetRequests');
            return cleanup();
        },
        stopInternetProbe: discarded('internetRequests'),
        canUseForegroundHighAccuracy: observe(false),
        refreshAvailableMemory: refusalAsync('nativeRequests', null),
        recentAvailableMemory: observe(null),
        startWatch: discarded('aisRequests'),
        isShareConfigured: observe(false),
        isShareEnabled: observe(false),
        isLowDataLink: observe(false),
        getShareStats: observe(stats),
        subscribeShareStats: listen(null, false),
        setShareEnabled: denied('aisRequests'),
        setLowDataLink: denied('aisRequests'),
        reportLink: denied('aisRequests'),
        offer: denied('aisRequests'),
        bindAppleCredentialUser: deniedAsync('appleRequests'),
        clearBoundAppleCredential: deniedAsync('appleRequests'),
        startAppleCredentialRevocationMonitoring: deniedAsync('appleRequests'),
        resolvePiWatchTarget: observe(null),
        probePiWatchCapability: refusalAsync(
            'anchorPiRequests',
            Object.freeze({ capable: false, reason: FULL_APP_BOUNDARY_UNAVAILABLE, hasFix: false }),
        ),
        readAnchorPiConfig: refusalAsync('anchorPiRequests', null),
        writeAnchorPiConfig: deniedAsync('anchorPiRequests'),
        clearAnchorPiConfig: deniedAsync('anchorPiRequests'),
        postAnchorState: refusalAsync('anchorPiRequests', 'not-configured' as const),
        mapAnchorState: observe(null),
        buildAnchorPayload: observe(null),
        payloadsEqual: observe(false),
        // Geometry imported through the denied service remains unavailable;
        // returning zero would invent a usable distance observation.
        haversineDistance: denied('anchorRequests'),
        // No original native error or location permission is classified here.
        isVoyageLocationError: observe(false),
        validateAndNormalizeAnchorWatchConfig: refusal(
            'anchorRequests',
            Object.freeze({ ok: false as const, error: FULL_APP_BOUNDARY_UNAVAILABLE }),
        ),
        initLocalDatabase: deniedAsync('vesselRequests'),
        getLocalDatabaseIdentity: observe(null),
        getLocalDatabaseSession: observe(Object.freeze({ identity: null, generation: -1 })),
        isLocalDatabaseSessionCurrent: observe(false),
        getPendingCount: observe(0),
        getFailedCount: observe(0),
        getSyncMeta: denied('vesselRequests'),
        generateUUID: denied('vesselRequests'),
        identityFileToken: denied('vesselRequests'),
        deltaLocal: deniedAsync('vesselRequests'),
        getAll: observe(Object.freeze([])),
        getById: observe(null),
        query: observe(Object.freeze([])),
        getPendingQueue: observe(Object.freeze([])),
        getFullQueue: observe(Object.freeze([])),
        onOutboxAppended: listen(null, false),
        atomicLocalTransaction: deniedAsync('vesselRequests'),
        insertLocal: deniedAsync('vesselRequests'),
        updateLocal: deniedAsync('vesselRequests'),
        deleteLocal: deniedAsync('vesselRequests'),
        bulkUpsert: deniedAsync('vesselRequests'),
        mergePulledRecords: deniedAsync('vesselRequests'),
        prunePulledTable: deniedAsync('vesselRequests'),
        applyRealtimeChange: deniedAsync('vesselRequests'),
        bulkDelete: deniedAsync('vesselRequests'),
        markSyncing: deniedAsync('vesselRequests'),
        removeSynced: deniedAsync('vesselRequests'),
        markFailed: deniedAsync('vesselRequests'),
        retryFailed: deniedAsync('vesselRequests'),
        rewriteQueuedInsert: deniedAsync('vesselRequests'),
        rewriteQueuedRecord: deniedAsync('vesselRequests'),
        discardUnsentRecord: deniedAsync('vesselRequests'),
        updateSyncMeta: deniedAsync('vesselRequests'),
        purgeLocalDatabaseForUser: deniedAsync('vesselRequests'),
        startSyncEngine: discarded('vesselRequests'),
        stopSyncEngine: discarded('vesselRequests'),
        syncNow: deniedAsync('vesselRequests'),
        forceFullPull: deniedAsync('vesselRequests'),
        requestFullReconciliation: deniedAsync('vesselRequests'),
        isFullReconciliationPending: observe(false),
        requestCatchUpSync: discarded('vesselRequests'),
        getSyncStatus: observe('offline' as const),
        onSyncComplete: listen(null, false),
        onStatusChange: listen('offline' as const),
        watchSharedBinderLoss: (..._args: unknown[]) => {
            count('subscriptions');
            return cleanup();
        },
        readCounters: (): FullAppBoundaryCounters => Object.freeze({ ...counters }),
    });
}
const boundaries = createFullAppStartupBoundaries();
export const {
    InstrumentSourcePolicy,
    GpsService,
    BgGeoManager,
    AnchorWatchService,
    AnchorWatchSyncService,
    AnchorPiPush,
    AnchorPiWatchKeeper,
    ShipLogService,
    piCache,
    KeepAwake,
    ScreenOrientation,
    PushNotifications,
    CapacitorHttp,
    warmUpGps,
    startInternetProbe,
    stopInternetProbe,
    startWatch,
    isShareConfigured,
    isShareEnabled,
    isLowDataLink,
    getShareStats,
    subscribeShareStats,
    setShareEnabled,
    setLowDataLink,
    reportLink,
    offer,
    bindAppleCredentialUser,
    clearBoundAppleCredential,
    startAppleCredentialRevocationMonitoring,
    canUseForegroundHighAccuracy,
    refreshAvailableMemory,
    recentAvailableMemory,
    resolvePiWatchTarget,
    probePiWatchCapability,
    readAnchorPiConfig,
    writeAnchorPiConfig,
    clearAnchorPiConfig,
    postAnchorState,
    initLocalDatabase,
    getLocalDatabaseIdentity,
    getLocalDatabaseSession,
    isLocalDatabaseSessionCurrent,
    mapAnchorState,
    buildAnchorPayload,
    payloadsEqual,
    haversineDistance,
    isVoyageLocationError,
    validateAndNormalizeAnchorWatchConfig,
    getPendingCount,
    getFailedCount,
    getSyncMeta,
    generateUUID,
    identityFileToken,
    deltaLocal,
    startSyncEngine,
    stopSyncEngine,
    getAll,
    getById,
    query,
    getPendingQueue,
    getFullQueue,
    onOutboxAppended,
    atomicLocalTransaction,
    insertLocal,
    updateLocal,
    deleteLocal,
    bulkUpsert,
    mergePulledRecords,
    prunePulledTable,
    applyRealtimeChange,
    bulkDelete,
    markSyncing,
    removeSynced,
    markFailed,
    retryFailed,
    rewriteQueuedInsert,
    rewriteQueuedRecord,
    discardUnsentRecord,
    updateSyncMeta,
    purgeLocalDatabaseForUser,
    requestCatchUpSync,
    syncNow,
    forceFullPull,
    requestFullReconciliation,
    isFullReconciliationPending,
    getSyncStatus,
    onSyncComplete,
    onStatusChange,
    watchSharedBinderLoss,
} = boundaries;
export const readFullAppBoundaryCounters = boundaries.readCounters;
