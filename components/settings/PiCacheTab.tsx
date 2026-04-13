/**
 * PiCacheTab — Settings panel for the Raspberry Pi Cache Server.
 *
 * Allows the punter to:
 *   - Enable/disable Pi Cache routing
 *   - Configure the Pi's hostname and port
 *   - Test the connection
 *   - View cache statistics
 *   - Purge expired cache entries
 */
import React, { useState, useCallback, useEffect } from 'react';
import { Section, Row, Toggle, type SettingsTabProps } from './SettingsPrimitives';
import { piCache, type PiCacheStatus } from '../../services/PiCacheService';

export const PiCacheTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const [status, setStatus] = useState<PiCacheStatus | null>(null);
    const [testing, setTesting] = useState(false);
    const [purging, setPurging] = useState(false);
    const [purgeResult, setPurgeResult] = useState<string | null>(null);

    const isEnabled = settings.piCacheEnabled ?? false;
    const host = settings.piCacheHost || 'raspberrypi.local';
    const port = settings.piCachePort || 3001;

    // Sync PiCacheService config when settings change
    useEffect(() => {
        piCache.configure({ enabled: isEnabled, host, port });
    }, [isEnabled, host, port]);

    // Get current status on mount
    useEffect(() => {
        if (isEnabled) {
            setStatus(piCache.getStatus());
        }
    }, [isEnabled]);

    const handleTest = useCallback(async () => {
        setTesting(true);
        setPurgeResult(null);
        try {
            const result = await piCache.ping();
            setStatus(result);
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
                // Refresh stats
                const newStatus = await piCache.ping();
                setStatus(newStatus);
            } else {
                setPurgeResult('Could not reach Pi');
            }
        } finally {
            setPurging(false);
        }
    }, []);

    return (
        <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
            {/* Hero banner */}
            <div className="mb-6 p-5 rounded-2xl bg-gradient-to-br from-emerald-500/10 to-teal-500/10 border border-emerald-500/20">
                <div className="flex items-start gap-3">
                    <div className="p-2 bg-emerald-500/20 rounded-xl">
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
                                d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z"
                            />
                        </svg>
                    </div>
                    <div>
                        <h3 className="text-white font-bold text-sm">Raspberry Pi Cache Server</h3>
                        <p className="text-gray-300 text-xs mt-1 leading-relaxed">
                            Route all weather, tide, GRIB, and satellite data through your boat&apos;s Pi for instant
                            responses. The Pi pre-downloads everything on schedule so your phone gets data in
                            milliseconds — even when the sat-phone is off.
                        </p>
                    </div>
                </div>
            </div>

            <Section title="Connection">
                <Row>
                    <div className="flex-1">
                        <label className="text-sm text-white font-medium block">Enable Pi Cache</label>
                        <p className="text-xs text-gray-400 mt-0.5">Route data through your Raspberry Pi</p>
                    </div>
                    <Toggle
                        checked={isEnabled}
                        onChange={(v) => onSave({ piCacheEnabled: v })}
                        label="Enable Pi Cache"
                    />
                </Row>

                {isEnabled && (
                    <>
                        <Row>
                            <div className="flex-1">
                                <label className="text-sm text-white font-medium block">Pi Hostname / IP</label>
                                <p className="text-xs text-gray-400 mt-0.5">Usually raspberrypi.local or a static IP</p>
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
                                <p className="text-xs text-gray-400 mt-0.5">Default: 3001</p>
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

                        <div className="p-4 border-t border-white/5">
                            <button
                                onClick={handleTest}
                                disabled={testing}
                                className={`w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all ${
                                    testing
                                        ? 'bg-sky-500/10 text-sky-300 cursor-wait'
                                        : 'bg-sky-500/20 text-sky-400 hover:bg-sky-500/30 active:scale-[0.98]'
                                }`}
                            >
                                {testing ? 'Testing Connection...' : 'Test Connection'}
                            </button>

                            {status && (
                                <div
                                    className={`mt-3 p-3 rounded-xl border text-xs ${
                                        status.reachable
                                            ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                                            : 'bg-red-500/10 border-red-500/20 text-red-300'
                                    }`}
                                >
                                    <div className="flex items-center gap-2">
                                        <div
                                            className={`w-2 h-2 rounded-full ${
                                                status.reachable
                                                    ? 'bg-emerald-400 shadow-lg shadow-emerald-400/50'
                                                    : 'bg-red-400'
                                            }`}
                                        />
                                        <span className="font-bold">
                                            {status.reachable ? 'Connected' : 'Unreachable'}
                                        </span>
                                        {status.latencyMs > 0 && (
                                            <span className="text-gray-400 ml-auto font-mono">
                                                {status.latencyMs}ms
                                            </span>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </Section>

            {isEnabled && status?.reachable && status.cacheStats && (
                <Section title="Cache Statistics">
                    <div className="p-4 grid grid-cols-2 gap-3">
                        <StatCard
                            label="API Entries"
                            value={status.cacheStats.kvEntries}
                            fresh={status.cacheStats.kvFresh}
                        />
                        <StatCard
                            label="Tile Entries"
                            value={status.cacheStats.tileEntries}
                            fresh={status.cacheStats.tileFresh}
                        />
                        <div className="col-span-2 flex items-center justify-between p-3 bg-white/[0.03] rounded-xl border border-white/5">
                            <span className="text-xs text-gray-400 uppercase font-bold tracking-wider">DB Size</span>
                            <span className="text-white font-mono text-sm font-bold">
                                {status.cacheStats.dbSizeMB} MB
                            </span>
                        </div>
                    </div>

                    <div className="p-4 border-t border-white/5">
                        <button
                            onClick={handlePurge}
                            disabled={purging}
                            className={`w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all ${
                                purging
                                    ? 'bg-amber-500/10 text-amber-300 cursor-wait'
                                    : 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 active:scale-[0.98]'
                            }`}
                        >
                            {purging ? 'Purging...' : 'Purge Expired Entries'}
                        </button>
                        {purgeResult && <p className="text-xs text-gray-400 mt-2 text-center">{purgeResult}</p>}
                    </div>
                </Section>
            )}

            {isEnabled && (
                <Section title="Pre-fetch">
                    <Row>
                        <div className="flex-1">
                            <label className="text-sm text-white font-medium block">Auto Pre-fetch</label>
                            <p className="text-xs text-gray-400 mt-0.5">
                                Pi downloads weather, GRIB, tides &amp; satellite tiles on a schedule
                            </p>
                        </div>
                        <Toggle
                            checked={settings.piCachePrefetch ?? true}
                            onChange={(v) => onSave({ piCachePrefetch: v })}
                            label="Enable pre-fetch"
                        />
                    </Row>
                    <div className="p-4 border-t border-white/5">
                        <p className="text-[11px] text-gray-500 leading-relaxed">
                            Configure the pre-fetch location and interval in the Pi&apos;s{' '}
                            <code className="text-emerald-400/70">.env</code> file. Set{' '}
                            <code className="text-emerald-400/70">PREFETCH_LAT</code> and{' '}
                            <code className="text-emerald-400/70">PREFETCH_LON</code> to your cruising ground.
                        </p>
                    </div>
                </Section>
            )}

            {/* Setup instructions */}
            {!isEnabled && (
                <div className="p-5 rounded-2xl bg-white/[0.02] border border-white/5 mt-2">
                    <h4 className="text-xs font-bold text-gray-300 uppercase tracking-wider mb-3">Quick Setup</h4>
                    <ol className="text-xs text-gray-400 space-y-2 list-decimal list-inside leading-relaxed">
                        <li>
                            Copy the <code className="text-sky-400/70">pi-cache/</code> folder to your Raspberry Pi
                        </li>
                        <li>
                            Run <code className="text-sky-400/70">npm install</code> then{' '}
                            <code className="text-sky-400/70">npm start</code>
                        </li>
                        <li>Enter your Pi&apos;s hostname or IP above and enable the toggle</li>
                        <li>All weather, GRIB, tide, and satellite data will route through the Pi</li>
                    </ol>
                </div>
            )}
        </div>
    );
};

/** Small stat card for cache statistics. */
const StatCard = ({ label, value, fresh }: { label: string; value: number; fresh: number }) => (
    <div className="p-3 bg-white/[0.03] rounded-xl border border-white/5">
        <p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">{label}</p>
        <p className="text-white font-mono text-lg font-bold mt-1">{value.toLocaleString()}</p>
        <p className="text-[10px] text-emerald-400/70 mt-0.5">{fresh} fresh</p>
    </div>
);
