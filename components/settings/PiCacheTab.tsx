/**
 * PiCacheTab — Settings panel for the Raspberry Pi Cache Server.
 *
 * Skipper-only (owner tier). The flow:
 *   1. Skipper flips the toggle
 *   2. We auto-discover the Pi on the local network
 *   3. If found → auto-connect, show green status
 *   4. If not found → offer ONE-TAP INSTALL (SSH provisioning)
 *      or manual hostname input as fallback
 *
 * No math required.
 */
import React, { useState, useCallback, useEffect } from 'react';
import { Section, Row, Toggle, type SettingsTabProps } from './SettingsPrimitives';
import { LockIcon } from '../Icons';
import { piCache, type PiCacheStatus } from '../../services/PiCacheService';
import { canAccess } from '../../services/SubscriptionService';
import { LocationStore } from '../../stores/LocationStore';
import {
    PiProvisionService,
    DEFAULT_USERNAME,
    type ProvisionProgress,
    type ProvisionPhase,
} from '../../services/PiProvisionService';
import { BoatNetworkService, useBoatNetwork } from '../../services/BoatNetworkService';
import { triggerHaptic } from '../../utils/system';

const SUPABASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
const SUPABASE_KEY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';
const OPEN_METEO_KEY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_OPEN_METEO_API_KEY) || '';

// ── Phase display config ──────────────────────────────────────

const PHASE_DISPLAY: Record<ProvisionPhase, { icon: string; color: string }> = {
    idle: { icon: '', color: '' },
    connecting: { icon: '🔌', color: 'text-sky-300' },
    checking: { icon: '🔍', color: 'text-sky-300' },
    installing: { icon: '📦', color: 'text-amber-300' },
    verifying: { icon: '✅', color: 'text-emerald-300' },
    configuring: { icon: '⚙️', color: 'text-sky-300' },
    done: { icon: '🎉', color: 'text-emerald-300' },
    error: { icon: '❌', color: 'text-red-300' },
};

// ── Component ─────────────────────────────────────────────────

export const PiCacheTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const [status, setStatus] = useState<PiCacheStatus | null>(null);
    const [discovering, setDiscovering] = useState(false);
    const [purging, setPurging] = useState(false);
    const [purgeResult, setPurgeResult] = useState<string | null>(null);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [testResult, setTestResult] = useState<{ ok: boolean; ms: number; source: string } | null>(null);
    const [testing, setTesting] = useState(false);

    // ── SSH Provisioning state ──
    const [showInstall, setShowInstall] = useState(false);
    const [sshHost, setSshHost] = useState('openplotter.local');
    const [sshUser, setSshUser] = useState(DEFAULT_USERNAME);
    const [sshPass, setSshPass] = useState('');
    const [provisioning, setProvisioning] = useState(false);
    const [provisionProgress, setProvisionProgress] = useState<ProvisionProgress | null>(null);
    const [provisionDone, setProvisionDone] = useState<{ success: boolean; message: string } | null>(null);

    const boatNetwork = useBoatNetwork();

    const isSkipper = canAccess(settings.subscriptionTier, 'piCache');
    const isEnabled = settings.piCacheEnabled ?? false;
    const host = settings.piCacheHost || '';
    const port = settings.piCachePort || 3001;
    const canSsh = PiProvisionService.isAvailable;

    // Sync PiCacheService config when settings change
    useEffect(() => {
        piCache.configure({ enabled: isEnabled, host, port });
    }, [isEnabled, host, port]);

    // Listen for status changes (auto-discovery results)
    useEffect(() => {
        const unsubscribe = piCache.onStatusChange(setStatus);
        if (isEnabled) {
            setStatus(piCache.getStatus());
        }
        return unsubscribe;
    }, [isEnabled]);

    /** Unified discovery: find Pi, probe all services, configure everything */
    const runUnifiedDiscovery = useCallback(
        async (preferredHost?: string) => {
            setDiscovering(true);
            try {
                const piHost = await BoatNetworkService.scan(preferredHost);
                if (piHost) {
                    // Auto-configure ALL services from one discovery
                    BoatNetworkService.applyToServices({
                        nmea: true,
                        avnav: true,
                        piCache: true,
                        onSaveSettings: (partial) => onSave(partial as Parameters<typeof onSave>[0]),
                    });

                    // Push Supabase config so Pi can pre-fetch weather
                    if (SUPABASE_URL && SUPABASE_KEY) {
                        const loc = LocationStore.getState();
                        piCache.pushConfig({
                            supabaseUrl: SUPABASE_URL,
                            supabaseAnonKey: SUPABASE_KEY,
                            openMeteoApiKey: OPEN_METEO_KEY || undefined,
                            prefetchLat: loc.lat,
                            prefetchLon: loc.lon,
                            prefetchRadius: 5,
                        });
                    }

                    // Update Pi Cache status display
                    const piStatus = await piCache.discover();
                    setStatus(piStatus);
                } else {
                    // Nothing found — update Pi Cache status
                    const piStatus = await piCache.discover();
                    setStatus(piStatus);
                }
            } finally {
                setDiscovering(false);
            }
        },
        [onSave],
    );

    // Auto-discover when toggle is enabled
    const handleEnable = useCallback(
        async (enabled: boolean) => {
            onSave({ piCacheEnabled: enabled });
            if (enabled) {
                await runUnifiedDiscovery();
            }
        },
        [onSave, runUnifiedDiscovery],
    );

    const handleScanAgain = useCallback(async () => {
        await runUnifiedDiscovery();
    }, [runUnifiedDiscovery]);

    const handleTest = useCallback(async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const start = Date.now();
            const result = await piCache.fetch<Record<string, unknown>>(
                '/api/weather/current',
                { lat: '-36.84', lon: '174.76' },
                async () => ({ test: 'direct-fallback' }),
            );
            setTestResult({
                ok: result.source !== 'direct',
                ms: Date.now() - start,
                source: result.source,
            });
        } catch {
            setTestResult({ ok: false, ms: 0, source: 'error' });
        } finally {
            setTesting(false);
        }
    }, []);

    const handlePurge = useCallback(async () => {
        setPurging(true);
        setPurgeResult(null);
        try {
            const result = await piCache.purgeCache();
            if (result) {
                setPurgeResult(`Purged ${result.kvDeleted} API + ${result.tileDeleted} tile entries`);
                const newStatus = await piCache.ping();
                setStatus(newStatus);
            } else {
                setPurgeResult('Could not reach Pi');
            }
        } finally {
            setPurging(false);
        }
    }, []);

    // ── SSH Provisioning ──
    const handleProvision = useCallback(async () => {
        if (!sshHost || !sshPass) return;

        setProvisioning(true);
        setProvisionDone(null);
        setProvisionProgress({ phase: 'connecting', message: 'Starting...' });
        triggerHaptic('medium');

        const loc = LocationStore.getState();
        const supabaseConfig =
            SUPABASE_URL && SUPABASE_KEY
                ? { url: SUPABASE_URL, key: SUPABASE_KEY, lat: loc.lat, lon: loc.lon }
                : undefined;

        try {
            const result = await PiProvisionService.provision(
                sshHost,
                sshUser || DEFAULT_USERNAME,
                sshPass,
                (progress) => setProvisionProgress(progress),
                supabaseConfig,
            );

            setProvisionDone({ success: result.success, message: result.message });

            if (result.success) {
                triggerHaptic('heavy');
                // Run unified discovery — finds Pi Cache + all other services
                // and auto-configures NMEA, AvNav, charts, everything
                await runUnifiedDiscovery(result.piHost);
            } else {
                triggerHaptic('medium');
            }
        } catch (err) {
            setProvisionDone({
                success: false,
                message: err instanceof Error ? err.message : 'Unknown error',
            });
            triggerHaptic('medium');
        } finally {
            setProvisioning(false);
            setSshPass(''); // Clear password from memory
        }
    }, [sshHost, sshUser, sshPass, onSave, runUnifiedDiscovery]);

    // ── Skipper-only gate ──
    if (!isSkipper) {
        return (
            <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
                <div className="p-8 rounded-2xl bg-white/[0.02] border border-white/5 text-center">
                    <LockIcon className="w-10 h-10 text-amber-500/50 mx-auto mb-4" />
                    <h3 className="text-white font-bold text-lg">Skipper Feature</h3>
                    <p className="text-gray-400 text-sm mt-2 leading-relaxed max-w-md mx-auto">
                        The Pi Cache server is a Skipper-tier feature. Upgrade to route all weather, GRIB, and satellite
                        data through your boat&apos;s Raspberry Pi for instant offline access.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
            {/* Hero */}
            <div className="mb-6 p-5 rounded-2xl bg-gradient-to-br from-emerald-500/10 to-teal-500/10 border border-emerald-500/20">
                <div className="flex items-start gap-3">
                    <div className="p-2.5 bg-emerald-500/20 rounded-xl">
                        <svg
                            className="w-6 h-6 text-emerald-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.5}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z"
                            />
                        </svg>
                    </div>
                    <div>
                        <h3 className="text-white font-bold text-sm">Pi Cache Server</h3>
                        <p className="text-gray-300 text-xs mt-1 leading-relaxed">
                            Got a Raspberry Pi on board? Flip the toggle and we&apos;ll find it. All your weather,
                            tides, and charts will load instantly from the Pi — no internet needed.
                        </p>
                    </div>
                </div>
            </div>

            {/* Main toggle */}
            <Section title="Connection">
                <Row>
                    <div className="flex-1">
                        <label className="text-sm text-white font-medium block">Use Pi Cache</label>
                        <p className="text-xs text-gray-400 mt-0.5">
                            {discovering ? 'Scanning your network...' : 'Route data through your Raspberry Pi'}
                        </p>
                    </div>
                    <Toggle checked={isEnabled} onChange={handleEnable} label="Enable Pi Cache" />
                </Row>

                {/* Discovery / status result */}
                {isEnabled && (
                    <div className="p-4 border-t border-white/5">
                        {discovering ? (
                            <div className="flex items-center gap-3 text-sky-300 text-xs">
                                <div className="w-4 h-4 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
                                <span>Looking for your Pi on the network...</span>
                            </div>
                        ) : status?.reachable ? (
                            <div className="space-y-2">
                                <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                                    <div className="flex items-center gap-2 text-xs">
                                        <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50 animate-pulse" />
                                        <span className="text-emerald-300 font-bold">Connected</span>
                                        <span className="text-gray-400 font-mono ml-1">
                                            {boatNetwork.piHost || status.discoveredVia || host}
                                        </span>
                                        {status.latencyMs > 0 && (
                                            <span className="text-gray-500 font-mono ml-auto">
                                                {status.latencyMs}ms
                                            </span>
                                        )}
                                    </div>
                                </div>
                                {/* Show all discovered services */}
                                {boatNetwork.services.length > 0 && (
                                    <div className="p-3 rounded-xl bg-white/[0.03] border border-white/5">
                                        <p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider mb-2">
                                            Auto-configured services
                                        </p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {boatNetwork.services.map((svc) => (
                                                <span
                                                    key={svc.name}
                                                    className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-mono"
                                                >
                                                    {svc.name === 'pi-cache' && 'Weather Cache'}
                                                    {svc.name === 'signalk' && 'Signal K'}
                                                    {svc.name === 'signalk-nmea' && 'NMEA TCP'}
                                                    {svc.name === 'avnav' && 'AvNav Charts'}
                                                    {svc.name === 'avnav-alt' && 'AvNav Charts'}
                                                    {![
                                                        'pi-cache',
                                                        'signalk',
                                                        'signalk-nmea',
                                                        'avnav',
                                                        'avnav-alt',
                                                    ].includes(svc.name) && svc.name}
                                                    <span className="text-gray-500 ml-1">:{svc.port}</span>
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                <button
                                    onClick={handleTest}
                                    disabled={testing}
                                    className="w-full py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] font-bold uppercase tracking-wider hover:bg-emerald-500/20 active:scale-[0.98] transition-all disabled:opacity-50"
                                >
                                    {testing ? 'Testing...' : 'Test Data Fetch'}
                                </button>
                                {testResult && (
                                    <div
                                        className={`p-2 rounded-lg text-[11px] text-center font-mono ${testResult.ok ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}
                                    >
                                        {testResult.ok
                                            ? `Weather fetched from Pi in ${testResult.ms}ms (${testResult.source})`
                                            : `Fell back to direct API (${testResult.ms}ms) — Pi may need Supabase config`}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="space-y-3">
                                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                                    <p className="text-amber-300 text-xs font-bold">Pi not found on your network</p>
                                    <p className="text-gray-400 text-[11px] mt-1">
                                        {canSsh
                                            ? "No worries — we can install it for you. Tap 'Install on Pi' below."
                                            : 'Make sure your Pi is on and connected to the same WiFi.'}
                                    </p>
                                </div>
                                <div className="flex gap-2">
                                    <button
                                        onClick={handleScanAgain}
                                        className="flex-1 py-2 rounded-xl bg-sky-500/20 text-sky-400 text-xs font-bold uppercase tracking-wider hover:bg-sky-500/30 active:scale-[0.98] transition-all"
                                    >
                                        Scan Again
                                    </button>
                                    {canSsh && (
                                        <button
                                            onClick={() => {
                                                setShowInstall(true);
                                                triggerHaptic('light');
                                            }}
                                            className="flex-1 py-2 rounded-xl bg-emerald-500/20 text-emerald-400 text-xs font-bold uppercase tracking-wider hover:bg-emerald-500/30 active:scale-[0.98] transition-all"
                                        >
                                            Install on Pi
                                        </button>
                                    )}
                                    <button
                                        onClick={() => setShowAdvanced(true)}
                                        className="px-4 py-2 rounded-xl bg-white/5 text-gray-400 text-xs font-bold uppercase tracking-wider hover:bg-white/10 active:scale-[0.98] transition-all"
                                    >
                                        Manual
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Advanced: manual hostname (hidden unless they click Manual) */}
                {isEnabled && (showAdvanced || (!status?.reachable && host)) && (
                    <>
                        <Row>
                            <div className="flex-1">
                                <label className="text-sm text-white font-medium block">Hostname / IP</label>
                            </div>
                            <input
                                type="text"
                                value={host}
                                onChange={(e) => onSave({ piCacheHost: e.target.value })}
                                className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm w-48 font-mono"
                                placeholder="raspberrypi.local"
                            />
                        </Row>
                        <Row>
                            <div className="flex-1">
                                <label className="text-sm text-white font-medium block">Port</label>
                            </div>
                            <input
                                type="number"
                                value={port}
                                onChange={(e) => onSave({ piCachePort: parseInt(e.target.value, 10) || 3001 })}
                                className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm w-24 font-mono text-center"
                                min={1}
                                max={65535}
                            />
                        </Row>
                    </>
                )}
            </Section>

            {/* ── One-Tap Install (SSH Provisioning) ── */}
            {isEnabled && showInstall && !status?.reachable && (
                <Section title="Install on Pi">
                    {!provisionDone ? (
                        <div className="p-4 space-y-3">
                            <p className="text-xs text-gray-300 leading-relaxed">
                                Enter your Pi&apos;s login details. We&apos;ll SSH in, install the cache server, and
                                connect automatically. Takes about 60 seconds.
                            </p>

                            {/* Hostname */}
                            <div>
                                <label className="text-[11px] text-gray-400 uppercase tracking-wider font-bold block mb-1">
                                    Pi Hostname / IP
                                </label>
                                <input
                                    type="text"
                                    value={sshHost}
                                    onChange={(e) => setSshHost(e.target.value)}
                                    disabled={provisioning}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm font-mono disabled:opacity-50"
                                    placeholder="openplotter.local"
                                />
                            </div>

                            {/* Username */}
                            <div>
                                <label className="text-[11px] text-gray-400 uppercase tracking-wider font-bold block mb-1">
                                    Username
                                </label>
                                <input
                                    type="text"
                                    value={sshUser}
                                    onChange={(e) => setSshUser(e.target.value)}
                                    disabled={provisioning}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm font-mono disabled:opacity-50"
                                    placeholder="user"
                                />
                            </div>

                            {/* Password */}
                            <div>
                                <label className="text-[11px] text-gray-400 uppercase tracking-wider font-bold block mb-1">
                                    Password
                                </label>
                                <input
                                    type="password"
                                    value={sshPass}
                                    onChange={(e) => setSshPass(e.target.value)}
                                    disabled={provisioning}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm font-mono disabled:opacity-50"
                                    placeholder="Your Pi password"
                                    autoComplete="off"
                                />
                                <p className="text-[10px] text-gray-500 mt-1">
                                    Only used once to install the service. Not stored.
                                </p>
                            </div>

                            {/* Progress indicator */}
                            {provisioning && provisionProgress && (
                                <div className="p-3 rounded-xl bg-slate-800/80 border border-white/5">
                                    <div className="flex items-center gap-2">
                                        {provisionProgress.phase !== 'done' && provisionProgress.phase !== 'error' && (
                                            <div className="w-4 h-4 border-2 border-sky-400 border-t-transparent rounded-full animate-spin shrink-0" />
                                        )}
                                        <span className={PHASE_DISPLAY[provisionProgress.phase]?.icon ? 'text-sm' : ''}>
                                            {PHASE_DISPLAY[provisionProgress.phase]?.icon}
                                        </span>
                                        <span
                                            className={`text-xs font-medium ${PHASE_DISPLAY[provisionProgress.phase]?.color || 'text-gray-300'}`}
                                        >
                                            {provisionProgress.message}
                                        </span>
                                    </div>
                                </div>
                            )}

                            {/* Action buttons */}
                            <div className="flex gap-2 pt-1">
                                <button
                                    onClick={handleProvision}
                                    disabled={provisioning || !sshHost || !sshPass}
                                    className="flex-1 py-3 rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-sm font-bold uppercase tracking-wider hover:bg-emerald-500/30 active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    {provisioning ? 'Installing...' : 'Install & Connect'}
                                </button>
                                {!provisioning && (
                                    <button
                                        onClick={() => setShowInstall(false)}
                                        className="px-4 py-3 rounded-xl bg-white/5 text-gray-400 text-sm font-bold uppercase tracking-wider hover:bg-white/10 active:scale-[0.98] transition-all"
                                    >
                                        Cancel
                                    </button>
                                )}
                            </div>
                        </div>
                    ) : (
                        /* ── Provision result ── */
                        <div className="p-4 space-y-3">
                            <div
                                className={`p-4 rounded-xl border ${
                                    provisionDone.success
                                        ? 'bg-emerald-500/10 border-emerald-500/20'
                                        : 'bg-red-500/10 border-red-500/20'
                                }`}
                            >
                                <div className="flex items-start gap-2">
                                    <span className="text-lg">{provisionDone.success ? '🎉' : '❌'}</span>
                                    <div>
                                        <p
                                            className={`text-sm font-bold ${provisionDone.success ? 'text-emerald-300' : 'text-red-300'}`}
                                        >
                                            {provisionDone.success ? 'All Set!' : 'Something Went Wrong'}
                                        </p>
                                        <p className="text-xs text-gray-400 mt-1">{provisionDone.message}</p>
                                    </div>
                                </div>
                            </div>
                            {!provisionDone.success && (
                                <button
                                    onClick={() => {
                                        setProvisionDone(null);
                                        setProvisionProgress(null);
                                    }}
                                    className="w-full py-2.5 rounded-xl bg-sky-500/20 text-sky-400 text-xs font-bold uppercase tracking-wider hover:bg-sky-500/30 active:scale-[0.98] transition-all"
                                >
                                    Try Again
                                </button>
                            )}
                        </div>
                    )}
                </Section>
            )}

            {/* Cache stats */}
            {isEnabled && status?.reachable && status.cacheStats && (
                <Section title="Cache">
                    <div className="p-4 grid grid-cols-3 gap-3">
                        <StatCard label="Weather" value={status.cacheStats.kvEntries} sub="responses" />
                        <StatCard label="Tiles" value={status.cacheStats.tileEntries} sub="cached" />
                        <StatCard label="Size" value={status.cacheStats.dbSizeMB} sub="MB" />
                    </div>
                    <div className="px-4 pb-4">
                        <button
                            onClick={handlePurge}
                            disabled={purging}
                            className={`w-full py-2 rounded-xl text-[11px] font-bold uppercase tracking-wider transition-all ${
                                purging
                                    ? 'bg-white/5 text-gray-500 cursor-wait'
                                    : 'bg-white/5 text-gray-400 hover:bg-white/10 active:scale-[0.98]'
                            }`}
                        >
                            {purging ? 'Cleaning...' : 'Clean Expired Data'}
                        </button>
                        {purgeResult && <p className="text-[11px] text-gray-500 mt-2 text-center">{purgeResult}</p>}
                    </div>
                </Section>
            )}

            {/* Pre-fetch */}
            {isEnabled && status?.reachable && (
                <Section title="Pre-fetch">
                    <Row>
                        <div className="flex-1">
                            <label className="text-sm text-white font-medium block">Auto Pre-fetch</label>
                            <p className="text-xs text-gray-400 mt-0.5">
                                Pi grabs weather &amp; charts in the background
                            </p>
                        </div>
                        <Toggle
                            checked={settings.piCachePrefetch ?? true}
                            onChange={(v) => onSave({ piCachePrefetch: v })}
                            label="Enable pre-fetch"
                        />
                    </Row>
                </Section>
            )}

            {/* Setup instructions — only when off */}
            {!isEnabled && (
                <div className="p-5 rounded-2xl bg-white/[0.02] border border-white/5 mt-2">
                    <h4 className="text-xs font-bold text-gray-300 uppercase tracking-wider mb-3">How It Works</h4>
                    <div className="text-xs text-gray-400 space-y-3 leading-relaxed">
                        {canSsh ? (
                            <>
                                <div className="flex gap-3 items-start">
                                    <span className="text-emerald-400 font-bold text-sm shrink-0">1</span>
                                    <p>
                                        Make sure your Pi is on the same WiFi as your phone and SSH is enabled
                                        (OpenPlotter has this on by default)
                                    </p>
                                </div>
                                <div className="flex gap-3 items-start">
                                    <span className="text-emerald-400 font-bold text-sm shrink-0">2</span>
                                    <p>
                                        Flip the toggle above — if we find the cache already running, you&apos;re done
                                    </p>
                                </div>
                                <div className="flex gap-3 items-start">
                                    <span className="text-emerald-400 font-bold text-sm shrink-0">3</span>
                                    <p>
                                        If not, tap <strong className="text-emerald-300">Install on Pi</strong> — enter
                                        your Pi&apos;s password and we handle the rest. One tap, no terminal needed.
                                    </p>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="flex gap-3 items-start">
                                    <span className="text-emerald-400 font-bold text-sm shrink-0">1</span>
                                    <div>
                                        <p>Open a terminal on your Raspberry Pi and run:</p>
                                        <div className="mt-2 p-3 rounded-lg bg-black/40 border border-white/10 font-mono text-[11px] text-emerald-300 break-all select-all">
                                            bash &lt;(curl -sSL
                                            https://raw.githubusercontent.com/shanestratton/thalassa-marine-weather/master/pi-cache/install.sh)
                                        </div>
                                        <p className="text-gray-500 text-[10px] mt-1">
                                            One command. Takes about 2 minutes. Runs automatically on boot after that.
                                        </p>
                                    </div>
                                </div>
                                <div className="flex gap-3 items-start">
                                    <span className="text-emerald-400 font-bold text-sm shrink-0">2</span>
                                    <p>Make sure your phone is on the same WiFi as the Pi</p>
                                </div>
                                <div className="flex gap-3 items-start">
                                    <span className="text-emerald-400 font-bold text-sm shrink-0">3</span>
                                    <p>Flip the toggle above — we find the Pi and set everything up automatically</p>
                                </div>
                            </>
                        )}
                        <p className="text-gray-500 text-[11px] pt-1">
                            All weather, tides, and charts load from the Pi instantly. No internet needed once cached.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};

const StatCard = ({ label, value, sub }: { label: string; value: number; sub: string }) => (
    <div className="p-3 bg-white/[0.03] rounded-xl border border-white/5 text-center">
        <p className="text-white font-mono text-lg font-bold">{value.toLocaleString()}</p>
        <p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider mt-0.5">{label}</p>
        <p className="text-[10px] text-emerald-400/50">{sub}</p>
    </div>
);
