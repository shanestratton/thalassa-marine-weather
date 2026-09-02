/**
 * AvNavPage — "Boat Network" dashboard in the Vessel Hub.
 *
 * Uses the unified BoatNetworkService to discover the Pi once,
 * then auto-configures AvNav charts, Signal K / NMEA, and Pi Cache.
 * Also includes the Chart Locker for uploading/downloading charts.
 */
import React, { useState, useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { AvNavService, type AvNavConnectionStatus } from '../../services/AvNavService';
import { BoatNetworkService, useBoatNetwork } from '../../services/BoatNetworkService';
import { PiProvisionService, DEFAULT_USERNAME, type ProvisionProgress } from '../../services/PiProvisionService';
import { NmeaListenerService } from '../../services/NmeaListenerService';
import { NmeaStore } from '../../services/NmeaStore';
import { piCache } from '../../services/PiCacheService';
import { useSettingsStore } from '../../stores/settingsStore';
import { LocationStore } from '../../stores/LocationStore';
import { triggerHaptic } from '../../utils/system';
import { PageHeader } from '../ui/PageHeader';
import { EncCellManager } from './EncCellManager';
import { S63LicensingCard } from './S63LicensingCard';
import { RemoteAccessSection } from '../settings/RemoteAccessSection';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import { PI_INTEGRATION_ENABLED } from '../../services/piPublicBetaBoundary';
import { PiPublicBetaUnavailable } from '../ui/PiPublicBetaUnavailable';

const SUPABASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
const SUPABASE_KEY =
    (typeof import.meta !== 'undefined' &&
        (import.meta.env?.VITE_SUPABASE_ANON_KEY || import.meta.env?.VITE_SUPABASE_KEY)) ||
    '';

interface AvNavPageProps {
    onBack: () => void;
    /** Production-safe escape to local, Pi-independent ENC management. */
    onOpenEncLibrary?: () => void;
}

const subscribeIdentity = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());

function sameScope(left: AuthIdentityScope, right: AuthIdentityScope): boolean {
    return left.key === right.key && left.generation === right.generation;
}

interface ScopedSshCredentials {
    scope: AuthIdentityScope;
    username: string;
    password: string;
}

interface ScopedProvisionProgress {
    scope: AuthIdentityScope;
    progress: ProvisionProgress | null;
}

// ── Phase display for SSH provisioning ──

const PHASE_DISPLAY: Record<string, { icon: string; color: string }> = {
    idle: { icon: '', color: '' },
    connecting: { icon: '\u{1F50C}', color: 'text-sky-300' },
    checking: { icon: '\u{1F50D}', color: 'text-sky-300' },
    installing: { icon: '\u{1F4E6}', color: 'text-amber-300' },
    verifying: { icon: '\u2705', color: 'text-emerald-300' },
    configuring: { icon: '\u2699\uFE0F', color: 'text-sky-300' },
    done: { icon: '\u{1F389}', color: 'text-emerald-300' },
    error: { icon: '\u274C', color: 'text-red-300' },
};

// ── Service badge config ──

const SERVICE_BADGES: Record<string, { label: string; color: string }> = {
    signalk: { label: 'Signal K :3000', color: 'bg-sky-500/15 border-sky-500/30 text-sky-400' },
    'signalk-nmea': { label: 'NMEA TCP :10110', color: 'bg-purple-500/15 border-purple-500/30 text-purple-400' },
    'pi-cache': { label: 'Weather Cache :3001', color: 'bg-amber-500/15 border-amber-500/30 text-amber-400' },
};

/** Get badge config for a service — handles dynamic avnav-* port names */
function getServiceBadge(service: { name: string; port: number }): { label: string; color: string } {
    if (SERVICE_BADGES[service.name]) return SERVICE_BADGES[service.name];
    if (service.name.startsWith('avnav')) {
        return {
            label: `AvNav Charts :${service.port}`,
            color: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400',
        };
    }
    return { label: `${service.name} :${service.port}`, color: 'bg-gray-500/15 border-gray-500/30 text-gray-400' };
}

// ── Main Component ──

const AvNavPageDevelopment: React.FC<AvNavPageProps> = ({ onBack }) => {
    const identityScope = useSyncExternalStore(subscribeIdentity, getAuthIdentityScope, getAuthIdentityScope);

    // ── Boat Network discovery state ──
    const network = useBoatNetwork();

    // ── AvNav chart state (still needed for chart list after connect) ──
    const [skStatus, setSkStatus] = useState<AvNavConnectionStatus>(AvNavService.getStatus());

    // ── "Connect All" state ──
    // DERIVED from the persisted wiring, with room for a session override.
    // A plain `useState(false)` reset on every mount, so leaving the page and
    // coming back offered to connect services that were already connected and
    // working. A one-shot initialiser would not fix it either: piHost arrives
    // asynchronously from discovery, so it reads null at mount and stays
    // wrong. Reading it each render is a localStorage lookup — free — and is
    // correct the moment the host is known.
    const [connectAllOverride, setConnectAllOverride] = useState<boolean | null>(null);

    // ── Provisioning state ──
    const [storedSshCredentials, setStoredSshCredentials] = useState<ScopedSshCredentials>(() => ({
        scope: identityScope,
        username: DEFAULT_USERNAME,
        password: '',
    }));
    const sshCredentials = sameScope(storedSshCredentials.scope, identityScope)
        ? storedSshCredentials
        : { scope: identityScope, username: DEFAULT_USERNAME, password: '' };
    const sshUsername = sshCredentials.username;
    const sshPassword = sshCredentials.password;
    const [storedProvisionProgress, setStoredProvisionProgress] = useState<ScopedProvisionProgress>(() => ({
        scope: identityScope,
        progress: null,
    }));
    const provisionProgress = sameScope(storedProvisionProgress.scope, identityScope)
        ? storedProvisionProgress.progress
        : null;
    const [provisionExpanded, setProvisionExpanded] = useState(false);
    const [copiedCommand, setCopiedCommand] = useState(false);

    useLayoutEffect(() => {
        setStoredSshCredentials((current) =>
            sameScope(current.scope, identityScope)
                ? current
                : { scope: identityScope, username: DEFAULT_USERNAME, password: '' },
        );
        setStoredProvisionProgress((current) =>
            sameScope(current.scope, identityScope) ? current : { scope: identityScope, progress: null },
        );
    }, [identityScope]);

    const updateSshUsername = useCallback(
        (username: string) => {
            const scope = identityScope;
            if (!isAuthIdentityScopeCurrent(scope)) return;
            setStoredSshCredentials((current) => ({
                scope,
                username,
                password: sameScope(current.scope, scope) ? current.password : '',
            }));
        },
        [identityScope],
    );

    const updateSshPassword = useCallback(
        (password: string) => {
            const scope = identityScope;
            if (!isAuthIdentityScopeCurrent(scope)) return;
            setStoredSshCredentials((current) => ({
                scope,
                username: sameScope(current.scope, scope) ? current.username : DEFAULT_USERNAME,
                password,
            }));
        },
        [identityScope],
    );

    const updateProvisionProgress = useCallback(
        (progress: ProvisionProgress | null) => {
            const scope = identityScope;
            if (!isAuthIdentityScopeCurrent(scope)) return;
            setStoredProvisionProgress({ scope, progress });
        },
        [identityScope],
    );

    /** Scroll focused input into view when iOS keyboard slides up */
    const scrollInputIntoView = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
        const el = e.currentTarget;
        // Delay lets iOS keyboard finish animating before we scroll
        setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 350);
    }, []);

    // Derived state
    const piHost = network.piHost;
    const connectAllDone = connectAllOverride ?? BoatNetworkService.isWiredTo(piHost);
    const setConnectAllDone = setConnectAllOverride;
    const skConnected = skStatus === 'connected';
    const skConnecting = skStatus === 'connecting';
    const hasPiCache = network.services.some((s) => s.name === 'pi-cache');
    const hasSignalK = network.services.some((s) => s.name === 'signalk');
    const hasNmea = network.services.some((s) => s.name === 'signalk-nmea');

    // Derive chart host/port from discovered services (any avnav-* service)
    const avnavService = network.services.find((s) => s.name.startsWith('avnav'));
    const signalkService = network.services.find((s) => s.name === 'signalk');
    const chartService = avnavService || signalkService;
    const chartPort = chartService?.port || 8080;
    // ALWAYS use 'avnav' mode when a Pi is detected — the multi-port scanner
    // in AvNavService.connect() will find the real AvNav port.
    // Only use 'signalk' if explicitly an SK-only setup (no Pi host).
    const chartServerType: 'avnav' | 'signalk' = piHost
        ? 'avnav'
        : chartService?.name === 'signalk'
          ? 'signalk'
          : 'avnav';

    useEffect(() => {
        const unsubSk = AvNavService.onStatusChange((s) => {
            setSkStatus(s);
        });

        return () => {
            unsubSk();
        };
    }, []);

    // ── Scan handler ──
    const handleScan = useCallback(() => {
        triggerHaptic('medium');
        setConnectAllDone(false);
        BoatNetworkService.scan();
    }, []);

    // ── Connect All handler ──
    const handleConnectAll = useCallback(() => {
        triggerHaptic('medium');
        if (!piHost) return;

        // 1. Apply to all downstream services via settings store + localStorage
        BoatNetworkService.applyToServices({
            nmea: true,
            avnav: true,
            piCache: true,
            onSaveSettings: (partial) => {
                // Persist to Zustand settings store (survives app restart via Capacitor Preferences)
                useSettingsStore.getState().updateSettings(partial as Record<string, unknown>);

                // Also write to localStorage as a fallback for boot()
                if (partial.piCacheEnabled !== undefined)
                    localStorage.setItem('thalassa_pi_cache_enabled', String(partial.piCacheEnabled));
                if (partial.piCacheHost !== undefined)
                    localStorage.setItem('thalassa_pi_cache_host', String(partial.piCacheHost));
                if (partial.piCachePort !== undefined)
                    localStorage.setItem('thalassa_pi_cache_port', String(partial.piCachePort));
                if (partial.piCachePrefetch !== undefined)
                    localStorage.setItem('thalassa_pi_cache_prefetch', String(partial.piCachePrefetch));
            },
        });

        // 2. Start AvNav chart service — stop first to force reconnect
        //    (autoStart may have already started with stale Signal K config)
        AvNavService.stop();
        AvNavService.configure(piHost, chartPort, chartServerType);
        AvNavService.start();

        // 3. Start NMEA listener if signalk-nmea found
        if (hasNmea || hasSignalK) {
            const nmeaPort = network.services.find((s) => s.name === 'signalk-nmea')?.port || 10110;
            NmeaListenerService.configure(piHost, nmeaPort);
            NmeaStore.start();
            NmeaListenerService.start();
        }

        // 4. Configure Pi Cache if found
        if (hasPiCache) {
            piCache.configure({ enabled: true, host: piHost, port: 3001 });
        }

        setConnectAllDone(true);
    }, [piHost, chartPort, chartServerType, hasNmea, hasSignalK, hasPiCache, network.services]);

    // ── Disconnect handler ──
    const handleDisconnect = useCallback(() => {
        triggerHaptic('medium');
        AvNavService.stop();
        // Clear the wiring as well as the connection. Stopping the service
        // alone left the saved chart host in place, so the next visit read as
        // connected again and the button flipped back on its own.
        BoatNetworkService.clearServiceWiring();
        setConnectAllDone(false);
    }, []);

    const sshAvailable = PiProvisionService.isAvailable;

    // ── SSH provisioning handler ──
    const handleInstallCache = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        triggerHaptic('medium');
        if (!piHost) return;

        if (!sshAvailable) {
            updateProvisionProgress({
                phase: 'error',
                message: 'SSH requires the native iOS app. Use the manual command above.',
            });
            return;
        }

        const operationUsername = sshUsername;
        const operationPassword = sshPassword;
        updateSshPassword('');
        updateProvisionProgress({ phase: 'connecting', message: 'Connecting via SSH...' });

        const loc = LocationStore.getState();
        const result = await PiProvisionService.provision(
            piHost,
            operationUsername,
            operationPassword,
            (progress) => {
                if (isAuthIdentityScopeCurrent(actionScope)) updateProvisionProgress(progress);
            },
            SUPABASE_URL && SUPABASE_KEY
                ? { url: SUPABASE_URL, key: SUPABASE_KEY, lat: loc.lat, lon: loc.lon }
                : undefined,
        );

        if (result.success && isAuthIdentityScopeCurrent(actionScope)) {
            BoatNetworkService.scan(piHost);
        }
    }, [identityScope, piHost, sshUsername, sshPassword, sshAvailable, updateProvisionProgress, updateSshPassword]);

    const provisionPhase = provisionProgress?.phase || 'idle';
    const provisionBusy = provisionPhase !== 'idle' && provisionPhase !== 'done' && provisionPhase !== 'error';

    return (
        <div className="w-full h-full flex flex-col bg-slate-950 slide-up-enter">
            <PageHeader title="Boat Network" subtitle="Ship's Office" onBack={onBack} />

            <div className="flex-1 overflow-y-auto px-4 pb-32">
                {/* ═══ BOAT NETWORK HERO ═══ */}
                <div
                    className={`shrink-0 mb-3 p-4 rounded-2xl border transition-all ${
                        piHost && network.services.length > 0
                            ? 'bg-emerald-500/10 border-emerald-500/20'
                            : 'bg-white/3 border-white/6'
                    }`}
                >
                    {/* Header */}
                    <div className="flex items-center gap-3">
                        <span className="text-lg">{'\u2693'}</span>
                        <div className="flex-1">
                            <p className="text-sm font-bold text-white">Boat Network</p>
                            {/* Both arms of the ternary this replaces were the
                                same string, so the condition was dead code. And
                                "charts" was the wrong word: the charts are on
                                the phone (EncCellStore writes them to
                                Directory.Data), and the Pi only converts a cell
                                on import. Saying the boat network carries your
                                charts is what makes a skipper wonder where they
                                went when the Pi is ashore. */}
                            <p className="text-[11px] text-gray-400">Pi, instruments &amp; weather cache</p>
                        </div>
                        {piHost && network.services.length > 0 && (
                            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50" />
                        )}
                    </div>

                    <div className="mt-4 space-y-3">
                        {/* ── Pi host display ── */}
                        {piHost && network.services.length > 0 && (
                            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                <span className="text-xs font-bold text-emerald-300 flex-1">{piHost}</span>
                                <span className="text-[11px] text-emerald-400/60 font-mono">
                                    {network.services.length} service{network.services.length !== 1 ? 's' : ''}
                                </span>
                            </div>
                        )}

                        {/* ── Service badges ── */}
                        {piHost && network.services.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                                {network.services.map((svc) => {
                                    const badge = getServiceBadge(svc);
                                    return (
                                        <span
                                            key={svc.name}
                                            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border ${badge.color}`}
                                        >
                                            {badge.label}
                                        </span>
                                    );
                                })}
                            </div>
                        )}

                        {/* ── Error / not found ── */}
                        {network.error && !network.scanning && (
                            <div className="px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20">
                                <p className="text-[11px] text-amber-400">{network.error}</p>
                            </div>
                        )}

                        {/* ── Scan button ── */}
                        {(!piHost || network.services.length === 0) && (
                            <button
                                onClick={handleScan}
                                disabled={network.scanning}
                                className={`w-full py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all active:scale-95 ${
                                    network.scanning
                                        ? 'bg-amber-500/15 border border-amber-500/30 text-amber-400'
                                        : 'bg-sky-500/15 border border-sky-500/30 text-sky-400 hover:bg-sky-500/25'
                                }`}
                            >
                                {network.scanning ? (
                                    <div className="flex items-center justify-center gap-2">
                                        <div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                                        Scanning...
                                    </div>
                                ) : (
                                    '\u{1F4E1} Find My Pi'
                                )}
                            </button>
                        )}

                        {/* ── Scan again (when Pi found) ── */}
                        {piHost && network.services.length > 0 && (
                            <div className="flex gap-2">
                                {/* Connect All */}
                                {!connectAllDone && !skConnected && (
                                    <button
                                        onClick={handleConnectAll}
                                        className="flex-1 py-2 rounded-xl text-xs font-black uppercase tracking-widest bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 transition-all active:scale-95"
                                    >
                                        Connect All
                                    </button>
                                )}

                                {connectAllDone && !skConnected && skConnecting && (
                                    <button
                                        onClick={handleDisconnect}
                                        className="flex-1 py-2 rounded-xl text-xs font-black uppercase tracking-widest bg-amber-500/15 border border-amber-500/30 text-amber-400 transition-all active:scale-95"
                                    >
                                        <div className="flex items-center justify-center gap-2">
                                            <div className="w-3.5 h-3.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                                            Connecting...
                                        </div>
                                    </button>
                                )}

                                {(skConnected || (connectAllDone && !skConnecting)) && (
                                    <button
                                        onClick={handleDisconnect}
                                        className="px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 transition-all active:scale-95"
                                    >
                                        Disconnect
                                    </button>
                                )}

                                {/* Scan Again */}
                                <button
                                    onClick={handleScan}
                                    disabled={network.scanning}
                                    className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all active:scale-95 ${
                                        network.scanning
                                            ? 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
                                            : 'bg-white/4 border border-white/8 text-gray-400 hover:bg-white/8'
                                    }`}
                                >
                                    {network.scanning ? (
                                        <div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                                    ) : (
                                        'Scan Again'
                                    )}
                                </button>
                            </div>
                        )}

                        {/* Debug probe removed — o-charts discovery working */}

                        {/* ── Install Weather Cache (when Pi found but pi-cache NOT) ── */}
                        {piHost && network.services.length > 0 && !hasPiCache && (
                            <div className="mt-2 p-3 rounded-xl bg-amber-500/5 border border-amber-500/10 space-y-2.5">
                                <button
                                    onClick={() => {
                                        triggerHaptic('light');
                                        setProvisionExpanded(!provisionExpanded);
                                    }}
                                    className="w-full flex items-center gap-2"
                                >
                                    <span className="text-sm">{'\u{1F4E6}'}</span>
                                    <div className="flex-1 text-left">
                                        <p className="text-xs font-bold text-amber-300">Install Weather Cache</p>
                                        <p className="text-[11px] text-gray-500">
                                            Pi found, but no weather cache service detected
                                        </p>
                                    </div>
                                    <svg
                                        className={`w-3.5 h-3.5 text-gray-500 transition-transform ${provisionExpanded ? 'rotate-180' : ''}`}
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                                        />
                                    </svg>
                                </button>

                                {provisionExpanded && (
                                    <div className="space-y-3">
                                        {/* ── Option 1: Auto-install via SSH (native app) ── */}
                                        {sshAvailable && (
                                            <div className="space-y-2">
                                                <p className="text-[10px] font-bold uppercase tracking-widest text-amber-400/60">
                                                    Auto Install via SSH
                                                </p>
                                                <p className="text-[11px] text-gray-400 leading-relaxed">
                                                    Thalassa will SSH into your Pi and install the weather cache
                                                    automatically.
                                                </p>
                                                <div className="flex gap-2">
                                                    <input
                                                        type="text"
                                                        value={sshUsername}
                                                        onChange={(e) => updateSshUsername(e.target.value)}
                                                        onFocus={scrollInputIntoView}
                                                        placeholder="Username"
                                                        className="w-24 shrink-0 px-3 py-2 rounded-xl bg-white/4 border border-white/8 text-xs text-white placeholder-gray-600 focus:outline-hidden focus:border-amber-500/30 font-mono"
                                                    />
                                                    <input
                                                        type="password"
                                                        value={sshPassword}
                                                        onChange={(e) => updateSshPassword(e.target.value)}
                                                        onFocus={scrollInputIntoView}
                                                        placeholder="Password"
                                                        className="flex-1 px-3 py-2 rounded-xl bg-white/4 border border-white/8 text-xs text-white placeholder-gray-600 focus:outline-hidden focus:border-amber-500/30"
                                                    />
                                                </div>
                                                <button
                                                    onClick={handleInstallCache}
                                                    disabled={!sshUsername || !sshPassword || provisionBusy}
                                                    className={`w-full py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all active:scale-95 ${
                                                        !sshUsername || !sshPassword || provisionBusy
                                                            ? 'bg-white/3 text-gray-400 cursor-not-allowed'
                                                            : 'bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25'
                                                    }`}
                                                >
                                                    {provisionBusy ? (
                                                        <div className="flex items-center justify-center gap-2">
                                                            <div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                                                            Installing...
                                                        </div>
                                                    ) : (
                                                        'Install on Pi'
                                                    )}
                                                </button>
                                            </div>
                                        )}

                                        {/* Provision progress */}
                                        {provisionProgress && provisionPhase !== 'idle' && (
                                            <div className="space-y-1.5 px-1">
                                                {(() => {
                                                    const pd = PHASE_DISPLAY[provisionPhase] || PHASE_DISPLAY.idle;
                                                    return (
                                                        <div className="flex items-center gap-2">
                                                            {pd.icon && <span className="text-sm">{pd.icon}</span>}
                                                            <span className={`text-[11px] font-bold ${pd.color}`}>
                                                                {provisionProgress.message}
                                                            </span>
                                                            {provisionBusy && (
                                                                <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin ml-auto" />
                                                            )}
                                                        </div>
                                                    );
                                                })()}
                                                {provisionProgress.output && (
                                                    <pre className="text-[10px] text-gray-400 font-mono max-h-24 overflow-y-auto bg-black/30 rounded-lg p-2 mt-1">
                                                        {provisionProgress.output.slice(-500)}
                                                    </pre>
                                                )}
                                            </div>
                                        )}

                                        {/* ── Option 2: Manual command ── */}
                                        <div className="space-y-1.5">
                                            <p className="text-[10px] font-bold uppercase tracking-widest text-white/50">
                                                {sshAvailable ? 'Or install manually' : 'Manual Install'}
                                            </p>
                                            <pre
                                                className="text-[10px] text-amber-300/70 font-mono bg-black/40 rounded-lg p-2.5 overflow-x-auto select-all cursor-pointer active:bg-black/60 transition-colors"
                                                onClick={(e) => {
                                                    const cmd =
                                                        'curl -fsSL https://raw.githubusercontent.com/shanestratton/thalassa-marine-weather/master/pi-cache/install.sh | sudo bash';
                                                    if (navigator.clipboard) {
                                                        // Confirm AFTER the write resolves — "Copied!" used to show
                                                        // regardless, and a rejected write was an unhandled
                                                        // rejection (audit 2026-09-02).
                                                        void navigator.clipboard
                                                            .writeText(cmd)
                                                            .then(() => {
                                                                triggerHaptic('light');
                                                                setCopiedCommand(true);
                                                                setTimeout(() => setCopiedCommand(false), 2000);
                                                            })
                                                            .catch(() => {
                                                                const range = document.createRange();
                                                                range.selectNodeContents(e.currentTarget);
                                                                window.getSelection()?.removeAllRanges();
                                                                window.getSelection()?.addRange(range);
                                                            });
                                                    } else {
                                                        const range = document.createRange();
                                                        range.selectNodeContents(e.currentTarget);
                                                        window.getSelection()?.removeAllRanges();
                                                        window.getSelection()?.addRange(range);
                                                    }
                                                }}
                                            >
                                                {`curl -fsSL https://raw.githubusercontent.com/shanestratton/thalassa-marine-weather/master/pi-cache/install.sh | sudo bash`}
                                            </pre>
                                            <p className="text-[10px] text-gray-500">
                                                {copiedCommand ? (
                                                    <span className="text-emerald-400 font-bold">Copied!</span>
                                                ) : (
                                                    'Tap to copy. Paste into a terminal on your Pi.'
                                                )}
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* ═══ ENC CHARTS (vector, routing-grade) ═══
                    Pulled up from below the Chart Locker so the Pi-cache
                    sync affordance is the FIRST chart-related thing the
                    user sees after the hero. Routing-grade vector data
                    is more important than raster display for the
                    routing engine and was previously buried under ~300
                    lines of raster-chart-downloader UI. */}
                <EncCellManager />

                {/* Licensing sits directly under the charts it unlocks, and leads
                    with the dongle check: an o-charts skipper needs none of it. */}
                <S63LicensingCard />

                {/* ═══ REMOTE ACCESS ═══
                    Shane 2026-08-29: moved here from the Advanced settings
                    tab. This page is the everyday "is the boat there?" glance,
                    and "can I reach the Pi from away?" is the same question
                    asked from further off — so it belongs beside discovery and
                    the service badges rather than behind Settings → Advanced.

                    It is about the PI, not the NMEA gateway. It briefly sat on
                    the gateway card yesterday and was wrong there: it runs
                    tailscale up on the Pi, while the YDWG is reached over the
                    RUTX50's advertised subnet whether the Pi is on or off.

                    Self-gating — renders nothing until the Pi is reachable. */}
                <RemoteAccessSection />
            </div>
        </div>
    );
};

/** Production beta replacement: no discovery, setup, chart, or Pi controls. */
export const AvNavPage: React.FC<AvNavPageProps> = (props) => {
    if (PI_INTEGRATION_ENABLED) return <AvNavPageDevelopment {...props} />;
    return (
        <div className="w-full h-full flex flex-col bg-slate-950 slide-up-enter">
            <PageHeader title="Boat Network" subtitle="Unavailable in public beta" onBack={props.onBack} />
            <div className="flex-1 overflow-y-auto">
                <PiPublicBetaUnavailable onOpenEncLibrary={props.onOpenEncLibrary} />
            </div>
        </div>
    );
};
