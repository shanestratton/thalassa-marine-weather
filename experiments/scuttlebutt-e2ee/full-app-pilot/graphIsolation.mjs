/** Exact build graph substitutions, not a runtime security sandbox. No ordinary
 * build imports this plugin. Unexpected production authority imports refuse. */
import { dirname, resolve, relative } from 'node:path';
import { realpathSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const repo = resolve(root, '../../..');
const clean = (id) => id?.split(/[?#]/)[0];
function canonicalPath(id) {
    let path = clean(id);
    if (!path || path.startsWith('\0')) return path;
    try {
        if (path.startsWith('file:')) path = fileURLToPath(path);
        else if (path.startsWith('/@fs/')) path = decodeURI(path.slice(4));
        path = resolve(clean(path));
    } catch {
        return null;
    }
    // Canonicalize an existing ancestor too: node_modules may be a symlink even
    // when the requested deep file is missing. Do not let spelling bypass policy.
    let existing = path;
    for (;;) {
        try {
            return resolve(realpathSync(existing), relative(existing, path));
        } catch {
            const parent = dirname(existing);
            if (parent === existing) return path;
            existing = parent;
        }
    }
}
const installedPackages = new Map();
for (const entry of readdirSync(resolve(repo, 'node_modules/@supabase'))) {
    installedPackages.set(realpathSync(resolve(repo, 'node_modules/@supabase', entry)), 'sdk');
}
installedPackages.set(realpathSync(resolve(repo, 'node_modules/@capacitor/core')), 'core');
function packageKind(id) {
    const path = canonicalPath(id);
    if (!path) return null;
    for (const [directory, kind] of installedPackages)
        if (path === directory || path.startsWith(directory + '/')) return kind;
    return null;
}
const prefix = '\0thalassa-full-app-closed:';
const names = (value) => value.split(' ');
const serviceModules = {
    'services/InstrumentSourcePolicy.ts': names('InstrumentSourcePolicy'),
    'services/GpsService.ts': names('GpsService canUseForegroundHighAccuracy'),
    'services/BgGeoManager.ts': names('BgGeoManager'),
    'services/gpsWarmUp.ts': names('warmUpGps'),
    'services/internetProbe.ts': names('startInternetProbe stopInternetProbe'),
    'services/AisShareService.ts': names(
        'startWatch isShareConfigured isShareEnabled isLowDataLink getShareStats subscribeShareStats setShareEnabled setLowDataLink reportLink offer',
    ),
    'services/auth/appleCredentialState.ts': names(
        'bindAppleCredentialUser clearBoundAppleCredential startAppleCredentialRevocationMonitoring',
    ),
    'services/AnchorWatchService.ts': names(
        'AnchorWatchService MIN_ANCHOR_SWING_RADIUS_M ANCHOR_WATCH_CONFIG_LIMITS validateAndNormalizeAnchorWatchConfig',
    ),
    'services/AnchorWatchSyncService.ts': names('AnchorWatchSyncService'),
    'services/anchorPiPush.ts': names(
        'AnchorPiPush readAnchorPiConfig writeAnchorPiConfig clearAnchorPiConfig postAnchorState mapAnchorState buildAnchorPayload payloadsEqual',
    ),
    'services/anchorPiWatchKeeper.ts': names('AnchorPiWatchKeeper resolvePiWatchTarget probePiWatchCapability'),
    'services/ShipLogService.ts': names('ShipLogService'),
    'services/PiCacheService.ts': names('piCache'),
    'services/native/memoryGauge.ts': names('refreshAvailableMemory recentAvailableMemory'),
    'services/vessel/LocalDatabase.ts': names(
        'initLocalDatabase getLocalDatabaseIdentity getLocalDatabaseSession isLocalDatabaseSessionCurrent getAll getById query atomicLocalTransaction insertLocal updateLocal deleteLocal deltaLocal bulkUpsert mergePulledRecords prunePulledTable applyRealtimeChange bulkDelete onOutboxAppended getPendingQueue getFullQueue markSyncing removeSynced markFailed retryFailed rewriteQueuedInsert getPendingCount getFailedCount getSyncMeta updateSyncMeta purgeLocalDatabaseForUser generateUUID',
    ),
    'services/vessel/SyncService.ts': names(
        'startSyncEngine stopSyncEngine syncNow forceFullPull requestFullReconciliation isFullReconciliationPending getSyncStatus onSyncComplete onStatusChange requestCatchUpSync',
    ),
};
const packages = {
    '@capacitor/preferences': ['boundaryMemory.ts', names('Preferences')],
    '@capacitor-community/keep-awake': ['boundaries.ts', names('KeepAwake')],
    '@capacitor/screen-orientation': ['boundaries.ts', names('ScreenOrientation')],
    '@capacitor/push-notifications': ['boundaries.ts', names('PushNotifications')],
    '@capacitor/app': ['nativeLeaves.ts', names('App')],
    '@capacitor/browser': ['nativeLeaves.ts', names('Browser')],
    '@capacitor/filesystem': ['nativeLeaves.ts', names('Filesystem Directory Encoding')],
    '@capacitor/geolocation': ['nativeLeaves.ts', names('Geolocation')],
    '@capacitor/haptics': ['nativeLeaves.ts', names('Haptics ImpactStyle NotificationType')],
    '@capacitor/keyboard': ['nativeLeaves.ts', names('Keyboard KeyboardResize KeyboardStyle')],
    '@capacitor/local-notifications': ['nativeLeaves.ts', names('LocalNotifications')],
    '@capacitor/network': ['nativeLeaves.ts', names('Network')],
    '@capacitor/share': ['nativeLeaves.ts', names('Share')],
    '@capacitor/status-bar': ['nativeLeaves.ts', names('StatusBar Style')],
    '@capacitor-community/apple-sign-in': ['nativeLeaves.ts', names('SignInWithApple')],
    '@capacitor-community/speech-recognition': ['nativeLeaves.ts', names('SpeechRecognition')],
    '@capacitor-community/native-audio': ['nativeLeaves.ts', names('NativeAudio')],
    '@transistorsoft/capacitor-background-geolocation': [
        'nativeLeaves.ts',
        ['BackgroundGeolocation', 'BackgroundGeolocation as default'],
    ],
    '@transistorsoft/capacitor-background-fetch': [
        'nativeLeaves.ts',
        ['BackgroundFetch', 'BackgroundFetch as default'],
    ],
};
const reexport = (file, exports) => `export {${exports.join(',')}} from ${JSON.stringify(resolve(root, file))};`;
const modules = new Map(
    Object.entries(serviceModules).map(([path, exports]) => [
        canonicalPath(resolve(repo, path)),
        reexport('boundaries.ts', exports),
    ]),
);
modules.set(
    canonicalPath(resolve(repo, 'stores/authStore.ts')),
    reexport('authStore.ts', names('useAuthStore handleNativeAppleCredentialRevocation')),
);
modules.set(
    canonicalPath(resolve(repo, 'services/nativeStorage.ts')),
    reexport(
        'boundaryMemory.ts',
        names(
            'DATA_CACHE_KEY VOYAGE_CACHE_KEY HISTORY_CACHE_KEY usesNativeEncryptedLargeStorage isAllowedEncryptedLargeStorageKey saveLargeData saveLargeDataImmediate loadLargeDataSync loadLargeData deleteLargeData flushPendingSaves readCacheVersion writeCacheVersion',
        ),
    ),
);
modules.set(
    canonicalPath(resolve(repo, 'services/supabase.ts')),
    reexport(
        'closedBackend.ts',
        names(
            'supabase supabaseUrl supabaseAnonKey isSupabaseConfigured capacitorAuthStorage migrateAuthSessionToCapacitor getCurrentUserId getCurrentUser getUserProfile updateUserProfile syncWaypoints',
        ),
    ),
);
modules.set(
    canonicalPath(resolve(repo, 'services/sentry.ts')),
    reexport(
        'closedBackend.ts',
        names('buildRelease captureException captureMessage addBreadcrumb setUser setTag ensureSentryLoaded'),
    ),
);
modules.set(
    canonicalPath(resolve(repo, 'components/LegacyChatPage.tsx')),
    "export function LegacyChatPage(){throw new Error('Legacy private messaging unavailable in full App Research')}",
);
const allowedCore = new Set([
    canonicalPath(resolve(repo, 'experiments/scuttlebutt-e2ee/bridge-web/auth.ts')),
    canonicalPath(resolve(root, 'sdk.ts')),
]);
const allowedSdk = new Set(allowedCore);
const chatClassifierImporter = canonicalPath(resolve(repo, 'services/ChatService.ts'));
function localSource(source, importer) {
    source = clean(source);
    if (source.startsWith('@/')) return resolve(repo, source.slice(2));
    if (source.startsWith('file:') || source.startsWith('/@fs/')) return canonicalPath(source);
    if (source.startsWith('/') && !source.startsWith('/@')) return source;
    if (source.startsWith('node_modules/')) return resolve(repo, source);
    if (source.startsWith('.') && importer) return resolve(dirname(canonicalPath(importer)), source);
    return null;
}
export function createFullAppGraphIsolation() {
    const virtual = new Map();
    // Admission is build-local and starts closed. It authorizes package-internal
    // loading only after an exact audited bare-package selection; ordinary
    // references remain refused even after that selection. This is not a runtime
    // sandbox or provenance attestation for installed third-party package code.
    const selected = { sdk: false, core: false };
    const issue = (key, code) => {
        const id = prefix + key;
        virtual.set(id, code);
        return id;
    };
    return {
        name: 'full-app-research-closed-graph',
        enforce: 'pre',
        resolveId(source, importer) {
            const parent = canonicalPath(importer);
            const parentKind = packageKind(importer);
            const path = localSource(source, importer);
            const referencedKind = packageKind(path);
            const namedSdk = /^@supabase\//.test(source);
            const namedCore = source === '@capacitor/core' || source.startsWith('@capacitor/core/');
            if (parentKind && selected[parentKind] && (referencedKind || namedSdk || namedCore)) {
                const requestedKind = referencedKind ?? (namedSdk ? 'sdk' : 'core');
                if (requestedKind !== parentKind)
                    throw new Error('Cross-package authority dependency forbidden in full App Research');
                return null; // Legitimate relative/self/dependency imports in the selected package family.
            }
            if (referencedKind)
                throw new Error('Direct installed authority package path forbidden in full App Research');
            if (source === '@supabase/supabase-js' && parent === chatClassifierImporter)
                return issue('chat-error-classifier', 'export function isAuthRetryableFetchError(){return false;}');
            if (source === '@capacitor/core') {
                if (allowedCore.has(parent)) {
                    selected.core = true;
                    return null;
                }
                return issue('core', reexport('core.ts', names('Capacitor CapacitorHttp registerPlugin WebPlugin')));
            }
            if (namedSdk) {
                if (source === '@supabase/supabase-js' && allowedSdk.has(parent)) {
                    selected.sdk = true;
                    return null;
                }
                throw new Error('Unexpected runtime SDK dependency in full App Research');
            }
            if (/^@sentry\//.test(source)) throw new Error('Telemetry dependency forbidden in full App Research');
            if (packages[source]) {
                const [file, exports] = packages[source];
                return issue(source, reexport(file, exports));
            }
            if (/^@(?:capacitor(?:-community)?|transistorsoft)\//.test(source))
                throw new Error('Unmapped native dependency in full App Research');
            if (!path) return null;
            for (const candidate of [path, path + '.ts', path + '.tsx']) {
                const canonical = canonicalPath(candidate);
                if (modules.has(canonical)) return issue(canonical, modules.get(canonical));
            }
            return null;
        },
        load(id) {
            const normalized = clean(id);
            if (virtual.has(normalized)) return virtual.get(normalized);
            const kind = packageKind(id);
            if (kind && !selected[kind])
                throw new Error('Unselected installed authority package reached full App Research');
            const path = canonicalPath(id);
            if (
                modules.has(path) ||
                path === canonicalPath(resolve(repo, 'services/sentrySdk.ts')) ||
                path === canonicalPath(resolve(repo, 'index.tsx')) ||
                path === canonicalPath(resolve(repo, 'ApplicationShell.tsx'))
            )
                throw new Error('Production entry or authority module reached full App Research');
            return null;
        },
    };
}
export const fullAppGraphSubstitutionPaths = Object.freeze([...modules.keys()]);
