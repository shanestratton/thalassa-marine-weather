/**
 * AvNavPage — Standalone AvNav Chart Server dashboard for the Vessel Hub.
 *
 * Dedicated page for managing AvNav/SignalK chart server connection,
 * network scanning, viewing available nautical charts, and the
 * Chart Locker for uploading/downloading charts to the Pi.
 */
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { AvNavService, type AvNavChart, type AvNavConnectionStatus } from '../../services/AvNavService';
import {
    AvNavDiscoveryService,
    type DiscoveredServer,
    type DiscoveryStatus,
} from '../../services/AvNavDiscoveryService';
import {
    ChartLockerService,
    type ChartPackage,
    type ChartRegion,
    type UploadProgress,
    type DownloadMode,
} from '../../services/ChartLockerService';
import { triggerHaptic } from '../../utils/system';
import { PageHeader } from '../ui/PageHeader';
import { FormField } from '../ui/FormField';
import { ModalSheet } from '../ui/ModalSheet';

const SETUP_GUIDE_KEY = 'thalassa_avnav_setup_dismissed';

interface AvNavPageProps {
    onBack: () => void;
}

// ── Chart Locker Sub-Components ──

/** Animated progress bar with phase label */
const ProgressBar: React.FC<{ progress: UploadProgress }> = ({ progress }) => {
    const phaseColors: Record<string, string> = {
        downloading: 'bg-sky-500',
        uploading: 'bg-emerald-500',
        deleting: 'bg-amber-500',
        done: 'bg-emerald-400',
        error: 'bg-red-500',
    };
    const barColor = phaseColors[progress.phase] || 'bg-white/20';
    const pct = Math.round(progress.progress * 100);

    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between">
                <span className="text-[11px] text-gray-400 uppercase tracking-wider font-bold">
                    {progress.phase === 'downloading'
                        ? '⬇ Downloading'
                        : progress.phase === 'uploading'
                          ? '⬆ Uploading to Pi'
                          : progress.phase === 'deleting'
                            ? '🗑 Cleaning up'
                            : progress.phase === 'done'
                              ? '✓ Complete'
                              : progress.phase === 'error'
                                ? '✗ Error'
                                : ''}
                </span>
                <span className="text-[11px] text-white/60 font-mono">{pct}%</span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                <div
                    className={`h-full rounded-full transition-all duration-300 ease-out ${barColor}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <p className="text-[11px] text-gray-500">{progress.message}</p>
            {progress.error && <p className="text-[11px] text-red-400 mt-1">{progress.error}</p>}
        </div>
    );
};

/** Single chart package row with download button */
const ChartPackageRow: React.FC<{
    pkg: ChartPackage;
    isActive: boolean;
    activeProgress: UploadProgress | null;
    onDownload: (pkg: ChartPackage) => void;
}> = ({ pkg, isActive, activeProgress, onDownload }) => {
    const sourceBadge = pkg.source === 'noaa' ? '🇺🇸' : pkg.source === 'linz' ? '🇳🇿' : '⛵';
    const busy =
        isActive &&
        activeProgress &&
        activeProgress.phase !== 'idle' &&
        activeProgress.phase !== 'done' &&
        activeProgress.phase !== 'error';
    const sizeLabel = pkg.sizeMB >= 1000 ? `${(pkg.sizeMB / 1024).toFixed(1)} GB` : `${pkg.sizeMB} MB`;

    return (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.04]">
            <span className="text-sm shrink-0">{sourceBadge}</span>
            <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-white truncate">{pkg.name}</p>
                {isActive && activeProgress && activeProgress.phase !== 'idle' ? (
                    <ProgressBar progress={activeProgress} />
                ) : (
                    <p className="text-[11px] text-gray-500">
                        {sizeLabel} · {pkg.isZipped ? 'ZIP → MBTiles' : pkg.format.toUpperCase()}
                        {pkg.source === 'linz' && ' · LINZ CC-BY'}
                        {pkg.credit && ` · ${pkg.credit}`}
                    </p>
                )}
            </div>
            <button
                onClick={() => {
                    triggerHaptic('light');
                    onDownload(pkg);
                }}
                disabled={!!busy}
                className={`shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-wider transition-all active:scale-95 ${
                    busy
                        ? 'bg-white/[0.03] text-gray-500 cursor-not-allowed'
                        : isActive && activeProgress?.phase === 'done'
                          ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400'
                          : isActive && activeProgress?.phase === 'error'
                            ? 'bg-red-500/15 border border-red-500/30 text-red-400'
                            : 'bg-sky-500/10 border border-sky-500/20 text-sky-400 hover:bg-sky-500/20'
                }`}
            >
                {busy ? (
                    <div className="w-3 h-3 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
                ) : isActive && activeProgress?.phase === 'done' ? (
                    '✓'
                ) : isActive && activeProgress?.phase === 'error' ? (
                    '↻'
                ) : (
                    '⬇'
                )}
            </button>
        </div>
    );
};

/** Region group header */
const RegionHeader: React.FC<{
    label: string;
    count: number;
    isExpanded: boolean;
    onToggle: () => void;
}> = ({ label, count, isExpanded, onToggle }) => (
    <button
        onClick={() => {
            triggerHaptic('light');
            onToggle();
        }}
        className="w-full flex items-center gap-2 py-2"
    >
        <svg
            className={`w-3 h-3 text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
        >
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
        <span className="text-[11px] font-bold uppercase tracking-widest text-white/40 flex-1 text-left">{label}</span>
        <span className="text-[11px] text-white/20 font-mono">{count}</span>
    </button>
);

// ── Main Component ──

export const AvNavPage: React.FC<AvNavPageProps> = ({ onBack }) => {
    // AvNav chart state
    const [skHost, setSkHost] = useState(AvNavService.getHost());
    const [skPort, setSkPort] = useState(() => {
        // AvNav defaults to port 8080 — only honour the saved port if it isn't
        // the Signal K default (3000) inherited from the shared service.
        const current = AvNavService.getPort();
        return current && current !== 3000 ? String(current) : '8080';
    });
    const [skStatus, setSkStatus] = useState<AvNavConnectionStatus>(AvNavService.getStatus());
    const [skCharts, setSkCharts] = useState<AvNavChart[]>(AvNavService.getCharts());
    const [skApiVersion, setSkApiVersion] = useState<string | null>(AvNavService.getApiVersion());
    const [skLastError, setSkLastError] = useState<string | null>(AvNavService.getLastError());
    const [skExpanded, setSkExpanded] = useState(true);
    const [scanStatus, setScanStatus] = useState<DiscoveryStatus>(AvNavDiscoveryService.getStatus());
    const [foundServers, setFoundServers] = useState<DiscoveredServer[]>(AvNavDiscoveryService.getServers());

    // Chart Locker state
    const [lockerExpanded, setLockerExpanded] = useState(false);
    const [deleteAfterUpload, setDeleteAfterUpload] = useState(true);
    const [downloadMode, setDownloadMode] = useState<DownloadMode>('phone-proxy');
    const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
    const [activePackageId, setActivePackageId] = useState<string | null>(null);
    const [expandedRegions, setExpandedRegions] = useState<Set<ChartRegion>>(new Set());
    const [localCharts, setLocalCharts] = useState<Array<{ name: string; size: number; uri: string }>>([]);

    // Setup Guide modal — auto-show on first visit, dismissable with "don't show again"
    const [showSetupGuide, setShowSetupGuide] = useState(() => {
        return localStorage.getItem(SETUP_GUIDE_KEY) !== 'true';
    });
    const [dontShowAgain, setDontShowAgain] = useState(false);

    const handleCloseGuide = useCallback(() => {
        if (dontShowAgain) {
            localStorage.setItem(SETUP_GUIDE_KEY, 'true');
        }
        setShowSetupGuide(false);
    }, [dontShowAgain]);

    // LINZ key from localStorage (same as ChartCatalogService)
    const linzKey = typeof localStorage !== 'undefined' ? localStorage.getItem('thalassa_linz_api_key') : null;

    // Build catalog
    const catalog = useMemo(() => ChartLockerService.getFullCatalog(linzKey), [linzKey]);
    const regions = useMemo(() => ChartLockerService.getRegions(catalog), [catalog]);

    // Refresh locally saved charts (downloaded to phone but not yet on AvNav)
    const refreshLocalCharts = useCallback(async () => {
        const charts = await ChartLockerService.getLocalCharts();
        setLocalCharts(charts);
    }, []);

    useEffect(() => {
        const unsubSk = AvNavService.onStatusChange((s) => {
            setSkStatus(s);
            setSkApiVersion(AvNavService.getApiVersion());
            setSkLastError(AvNavService.getLastError());
        });
        const unsubSkCharts = AvNavService.onChartsChange((c) => setSkCharts(c));
        const unsubScanStatus = AvNavDiscoveryService.onStatusChange(setScanStatus);
        const unsubScanServers = AvNavDiscoveryService.onServersChange(setFoundServers);

        // Load locally downloaded charts
        refreshLocalCharts();

        return () => {
            unsubSk();
            unsubSkCharts();
            unsubScanStatus();
            unsubScanServers();
        };
    }, [refreshLocalCharts]);

    const handleSkConnect = useCallback(() => {
        triggerHaptic('medium');
        // AvNav default port is 8080 (not 3000 — that's Signal K's default).
        AvNavService.configure(skHost, parseInt(skPort, 10) || 8080, 'avnav');
        AvNavService.start();
    }, [skHost, skPort]);

    const handleSkDisconnect = useCallback(() => {
        triggerHaptic('medium');
        AvNavService.stop();
    }, []);

    const skConnected = skStatus === 'connected';
    const skConnecting = skStatus === 'connecting';
    const isScanning = scanStatus === 'scanning';

    const handleScanNetwork = useCallback(() => {
        triggerHaptic('medium');
        AvNavDiscoveryService.scan();
    }, []);

    const handleSelectServer = useCallback((server: DiscoveredServer) => {
        triggerHaptic('light');
        setSkHost(server.host);
        setSkPort(String(server.port));
        AvNavDiscoveryService.stop();
    }, []);

    const handleStopScan = useCallback(() => {
        triggerHaptic('light');
        AvNavDiscoveryService.stop();
    }, []);

    // ── Chart Locker Handlers ──

    const handlePickAndUpload = useCallback(async () => {
        triggerHaptic('medium');
        setActivePackageId('local-upload');
        setUploadProgress(null);

        if (!skConnected) {
            // No AvNav connection — save to phone for later upload
            await ChartLockerService.pickAndSaveToPhone(setUploadProgress);
            refreshLocalCharts();
        } else {
            // Connected — pick and upload directly
            await ChartLockerService.pickAndUpload(
                skHost,
                parseInt(skPort, 10) || 8080,
                deleteAfterUpload,
                setUploadProgress,
            );
        }
    }, [skHost, skPort, deleteAfterUpload, skConnected, refreshLocalCharts]);

    const handleDownloadChart = useCallback(
        async (pkg: ChartPackage) => {
            triggerHaptic('medium');
            setActivePackageId(pkg.id);
            setUploadProgress(null);

            if (!skConnected) {
                // No AvNav connection — save to phone only
                await ChartLockerService.downloadToPhoneOnly(pkg, setUploadProgress);
                refreshLocalCharts();
            } else {
                // Full flow: download + upload to AvNav
                await ChartLockerService.downloadChart(
                    pkg,
                    downloadMode,
                    skHost,
                    parseInt(skPort, 10) || 8080,
                    deleteAfterUpload,
                    setUploadProgress,
                );
            }
        },
        [downloadMode, skHost, skPort, deleteAfterUpload, skConnected, refreshLocalCharts],
    );

    const handleUploadLocal = useCallback(
        async (fileName: string) => {
            triggerHaptic('medium');
            setActivePackageId(`local-${fileName}`);
            setUploadProgress(null);

            await ChartLockerService.uploadLocalChart(
                fileName,
                skHost,
                parseInt(skPort, 10) || 8080,
                deleteAfterUpload,
                setUploadProgress,
            );
            refreshLocalCharts();
        },
        [skHost, skPort, deleteAfterUpload, refreshLocalCharts],
    );

    const handleDeleteLocal = useCallback(
        async (fileName: string) => {
            triggerHaptic('light');
            await ChartLockerService.deleteLocalChart(fileName);
            refreshLocalCharts();
        },
        [refreshLocalCharts],
    );

    const toggleRegion = useCallback((region: ChartRegion) => {
        setExpandedRegions((prev) => {
            const next = new Set(prev);
            if (next.has(region)) {
                next.delete(region);
            } else {
                next.add(region);
            }
            return next;
        });
    }, []);

    const isBusy =
        uploadProgress != null &&
        uploadProgress.phase !== 'idle' &&
        uploadProgress.phase !== 'done' &&
        uploadProgress.phase !== 'error';

    return (
        <div className="w-full h-full flex flex-col bg-slate-950 slide-up-enter">
            <PageHeader title="AvNav Charts" onBack={onBack} />

            <div className="flex-1 overflow-y-auto px-4 pb-32">
                {/* ═══ CONNECTION STATUS HERO ═══ */}
                <div
                    className={`shrink-0 mb-3 p-4 rounded-2xl border transition-all ${
                        skConnected ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-white/[0.03] border-white/[0.06]'
                    }`}
                >
                    {/* Header */}
                    <button onClick={() => setSkExpanded(!skExpanded)} className="w-full flex items-center gap-3">
                        <span className="text-lg">⚓</span>
                        <div className="flex-1 text-left">
                            <p className="text-sm font-bold text-white">AvNav — Nautical Charts</p>
                            <p className="text-[11px] text-gray-400">
                                {skConnected
                                    ? `Connected · API ${skApiVersion || 'v1'} · ${skCharts.length} chart(s)`
                                    : 'Connect to your AvNav server for chart overlays'}
                            </p>
                        </div>
                        {skConnected && (
                            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50" />
                        )}
                        <svg
                            className={`w-4 h-4 text-gray-500 transition-transform ${skExpanded ? 'rotate-180' : ''}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                        </svg>
                    </button>

                    {/* Expandable content */}
                    {skExpanded && (
                        <div className="mt-4 space-y-3">
                            {/* Error display */}
                            {skLastError && !skConnected && (
                                <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20">
                                    <p className="text-[11px] text-red-400">{skLastError}</p>
                                </div>
                            )}

                            {/* Network Scan */}
                            {!skConnected && (
                                <div className="space-y-2">
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={isScanning ? handleStopScan : handleScanNetwork}
                                            className={`flex-1 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all active:scale-95 ${
                                                isScanning
                                                    ? 'bg-amber-500/15 border border-amber-500/30 text-amber-400'
                                                    : 'bg-sky-500/15 border border-sky-500/30 text-sky-400 hover:bg-sky-500/25'
                                            }`}
                                        >
                                            {isScanning ? (
                                                <div className="flex items-center justify-center gap-2">
                                                    <div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                                                    Scanning…
                                                </div>
                                            ) : (
                                                '📡 Scan Network'
                                            )}
                                        </button>
                                    </div>

                                    {/* Found servers */}
                                    {foundServers.length > 0 && (
                                        <div className="space-y-1">
                                            {foundServers.map((server, i) => (
                                                <button
                                                    key={i}
                                                    onClick={() => handleSelectServer(server)}
                                                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/20 transition-all active:scale-95"
                                                >
                                                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                                    <span className="text-xs font-bold text-emerald-300 flex-1 text-left">
                                                        {server.name || server.host}
                                                    </span>
                                                    <span className="text-[11px] text-emerald-400/60 font-mono">
                                                        {server.host}:{server.port}
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    )}

                                    {isScanning && foundServers.length === 0 && (
                                        <p className="text-[11px] text-gray-500 text-center py-1">
                                            Scanning local network for AvNav servers…
                                        </p>
                                    )}

                                    {!isScanning && scanStatus === 'idle' && foundServers.length === 0 && (
                                        <p className="text-[11px] text-gray-500 text-center py-1">
                                            No AvNav servers found. Enter the address manually below.
                                        </p>
                                    )}
                                </div>
                            )}

                            {/* Host/Port fields */}
                            <div className="flex gap-2">
                                <div className="flex-1">
                                    <FormField
                                        label="Host"
                                        value={skHost}
                                        onChange={setSkHost}
                                        placeholder="192.168.x.x"
                                        disabled={skConnected}
                                    />
                                </div>
                                <div className="w-24">
                                    <FormField
                                        label="Port"
                                        value={skPort}
                                        onChange={setSkPort}
                                        placeholder="8080"
                                        disabled={skConnected}
                                    />
                                </div>
                            </div>

                            {/* Connect / Disconnect */}
                            <div className="flex gap-2">
                                {!skConnected && !skConnecting && (
                                    <button
                                        onClick={handleSkConnect}
                                        className="flex-1 py-2 rounded-xl text-xs font-black uppercase tracking-widest bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 transition-all active:scale-95"
                                    >
                                        Connect
                                    </button>
                                )}
                                {skConnecting && (
                                    <button
                                        onClick={handleSkDisconnect}
                                        className="flex-1 py-2 rounded-xl text-xs font-black uppercase tracking-widest bg-amber-500/15 border border-amber-500/30 text-amber-400 transition-all active:scale-95"
                                    >
                                        <div className="flex items-center justify-center gap-2">
                                            <div className="w-3.5 h-3.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                                            Connecting…
                                        </div>
                                    </button>
                                )}
                                {(skConnected || skConnecting) && (
                                    <button
                                        onClick={handleSkDisconnect}
                                        className="px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 transition-all active:scale-95"
                                    >
                                        Disconnect
                                    </button>
                                )}
                            </div>

                            {/* Chart list */}
                            {skConnected && skCharts.length > 0 && (
                                <div className="space-y-1">
                                    <p className="text-[11px] font-bold uppercase tracking-widest text-white/40">
                                        Charts Available
                                    </p>
                                    {skCharts.map((chart) => (
                                        <div
                                            key={chart.id}
                                            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.04]"
                                        >
                                            <span className="text-sm">🗺️</span>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-xs font-bold text-white truncate">{chart.name}</p>
                                                <p className="text-[11px] text-gray-500">
                                                    z{chart.minZoom}–{chart.maxZoom} · {chart.format}
                                                </p>
                                            </div>
                                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                        </div>
                                    ))}
                                </div>
                            )}

                            {skConnected && skCharts.length === 0 && (
                                <p className="text-[11px] text-gray-500 text-center py-2">
                                    No charts found — use the{' '}
                                    <span className="text-sky-400 font-bold">Chart Locker</span> below to install
                                    charts.
                                </p>
                            )}
                        </div>
                    )}
                </div>

                {/* ═══ CHART LOCKER ═══ */}
                <div className="mb-3 p-4 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                    {/* Header */}
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            setLockerExpanded(!lockerExpanded);
                        }}
                        className="w-full flex items-center gap-3"
                    >
                        <span className="text-lg">📦</span>
                        <div className="flex-1 text-left">
                            <p className="text-sm font-bold text-white">Chart Locker</p>
                            <p className="text-[11px] text-gray-400">Free charts, o-charts & community charts</p>
                        </div>
                        <svg
                            className={`w-4 h-4 text-gray-500 transition-transform ${lockerExpanded ? 'rotate-180' : ''}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                        </svg>
                    </button>

                    {lockerExpanded && (
                        <div className="mt-4 space-y-4">
                            {/* ── Your Chart Files ── */}
                            <div className="space-y-2">
                                <p className="text-[11px] font-bold uppercase tracking-widest text-white/40">
                                    Your Chart Files
                                </p>
                                <p className="text-[11px] text-gray-500 leading-relaxed">
                                    Select chart files from your phone — o-charts, free charts, anything.{' '}
                                    {skConnected
                                        ? 'Uploads directly to your AvNav Pi.'
                                        : 'Saves to phone for later upload to AvNav.'}{' '}
                                    <span className="text-emerald-400 font-mono">.mbtiles</span>{' '}
                                    <span className="text-amber-400 font-mono">.oesenc</span>{' '}
                                    <span className="text-sky-400 font-mono">.gemf</span>{' '}
                                    <span className="text-purple-400 font-mono">.kap</span>
                                </p>

                                {/* Upload progress (for local file upload) */}
                                {activePackageId === 'local-upload' &&
                                    uploadProgress &&
                                    uploadProgress.phase !== 'idle' && (
                                        <div className="px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.04]">
                                            <ProgressBar progress={uploadProgress} />
                                        </div>
                                    )}

                                <button
                                    onClick={handlePickAndUpload}
                                    disabled={isBusy}
                                    className={`w-full py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all active:scale-95 ${
                                        isBusy
                                            ? 'bg-amber-500/10 border border-amber-500/20 text-amber-400 cursor-not-allowed'
                                            : 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25'
                                    }`}
                                >
                                    {isBusy ? (
                                        <span className="flex items-center justify-center gap-2">
                                            <span className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                                            Working…
                                        </span>
                                    ) : skConnected ? (
                                        '📂 Select & Upload to AvNav'
                                    ) : (
                                        '📂 Select & Save to Phone'
                                    )}
                                </button>
                            </div>

                            {/* ── Charts Saved on Phone ── */}
                            {localCharts.length > 0 && (
                                <div className="space-y-2">
                                    <div className="flex items-center gap-2">
                                        <p className="text-[11px] font-bold uppercase tracking-widest text-white/40 flex-1">
                                            Charts on Phone
                                        </p>
                                        <span className="text-[11px] text-amber-400/60 font-mono bg-amber-500/10 px-2 py-0.5 rounded-full">
                                            {localCharts.length} file{localCharts.length !== 1 ? 's' : ''}
                                        </span>
                                    </div>
                                    <p className="text-[11px] text-gray-500 leading-relaxed">
                                        {skConnected
                                            ? 'Tap ⬆ to upload saved charts to your AvNav server.'
                                            : 'Connect to AvNav to upload these charts to your Pi.'}
                                    </p>
                                    {localCharts.map((chart) => {
                                        const isLocalActive = activePackageId === `local-${chart.name}`;
                                        const localBusy =
                                            isLocalActive &&
                                            uploadProgress &&
                                            uploadProgress.phase !== 'idle' &&
                                            uploadProgress.phase !== 'done' &&
                                            uploadProgress.phase !== 'error';
                                        const sizeStr =
                                            chart.size >= 1024 * 1024 * 1024
                                                ? `${(chart.size / 1024 / 1024 / 1024).toFixed(1)} GB`
                                                : `${Math.round(chart.size / 1024 / 1024)} MB`;

                                        return (
                                            <div
                                                key={chart.name}
                                                className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.04]"
                                            >
                                                <span className="text-sm shrink-0">📱</span>
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-xs font-bold text-white truncate">
                                                        {chart.name}
                                                    </p>
                                                    {isLocalActive &&
                                                    uploadProgress &&
                                                    uploadProgress.phase !== 'idle' ? (
                                                        <ProgressBar progress={uploadProgress} />
                                                    ) : (
                                                        <p className="text-[11px] text-gray-500">
                                                            {sizeStr} · Saved on phone
                                                        </p>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-1 shrink-0">
                                                    {skConnected && (
                                                        <button
                                                            onClick={() => handleUploadLocal(chart.name)}
                                                            disabled={isBusy}
                                                            className={`px-2.5 py-1.5 rounded-lg text-[11px] font-black transition-all active:scale-95 ${
                                                                localBusy
                                                                    ? 'bg-white/[0.03] text-gray-500 cursor-not-allowed'
                                                                    : isLocalActive && uploadProgress?.phase === 'done'
                                                                      ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400'
                                                                      : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20'
                                                            }`}
                                                        >
                                                            {localBusy ? (
                                                                <div className="w-3 h-3 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
                                                            ) : isLocalActive && uploadProgress?.phase === 'done' ? (
                                                                '✓'
                                                            ) : (
                                                                '⬆'
                                                            )}
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={() => handleDeleteLocal(chart.name)}
                                                        disabled={isBusy}
                                                        className={`px-2.5 py-1.5 rounded-lg text-[11px] font-black transition-all active:scale-95 ${
                                                            isBusy
                                                                ? 'bg-white/[0.03] text-gray-500 cursor-not-allowed'
                                                                : 'bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20'
                                                        }`}
                                                    >
                                                        🗑
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {/* ── o-Charts ── */}
                            <div className="space-y-2">
                                <p className="text-[11px] font-bold uppercase tracking-widest text-white/40">
                                    o-Charts (Paid)
                                </p>
                                <div className="px-3 py-3 rounded-xl bg-amber-500/5 border border-amber-500/10 space-y-2.5">
                                    <p className="text-[11px] text-gray-300 leading-relaxed">
                                        Premium nautical charts from{' '}
                                        <span className="text-amber-400 font-bold">o-charts.org</span> — official
                                        hydrographic office data with worldwide coverage.
                                    </p>

                                    <div className="space-y-1.5 text-[11px]">
                                        <div className="flex items-start gap-2">
                                            <span className="text-amber-400 mt-0.5 shrink-0">1.</span>
                                            <span className="text-gray-400">
                                                Purchase charts at{' '}
                                                <span className="text-amber-300 font-bold">o-charts.org</span> and
                                                download the <span className="font-mono text-amber-300">.oesenc</span>{' '}
                                                files to your phone or computer
                                            </span>
                                        </div>
                                        <div className="flex items-start gap-2">
                                            <span className="text-amber-400 mt-0.5 shrink-0">2.</span>
                                            <span className="text-gray-400">
                                                Tap{' '}
                                                <span className="text-emerald-400 font-bold">
                                                    Select {skConnected ? '& Upload to AvNav' : '& Save to Phone'}
                                                </span>{' '}
                                                above to pick the file
                                                {skConnected
                                                    ? ' — it uploads straight to your Pi'
                                                    : ' — save it now, upload when on the boat'}
                                            </span>
                                        </div>
                                        <div className="flex items-start gap-2">
                                            <span className="text-amber-400 mt-0.5 shrink-0">3.</span>
                                            <span className="text-gray-400">
                                                Plug the{' '}
                                                <span className="text-white font-bold">o-charts USB dongle</span> into
                                                your AvNav Pi — required for decryption
                                            </span>
                                        </div>
                                    </div>

                                    <p className="text-[10px] text-gray-500 border-t border-amber-500/10 pt-2">
                                        o-charts are DRM-protected — they can only be decrypted by AvNav/OpenCPN with
                                        the USB dongle attached. They cannot be viewed directly on the phone.
                                    </p>
                                </div>
                            </div>

                            {/* ── Settings ── */}
                            <div className="space-y-2 px-1">
                                {/* Delete after upload toggle */}
                                <button
                                    onClick={() => {
                                        triggerHaptic('light');
                                        setDeleteAfterUpload(!deleteAfterUpload);
                                    }}
                                    className="w-full flex items-center gap-3"
                                >
                                    <div
                                        className={`w-8 h-4.5 rounded-full transition-colors relative ${deleteAfterUpload ? 'bg-emerald-500' : 'bg-white/10'}`}
                                    >
                                        <div
                                            className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${deleteAfterUpload ? 'translate-x-4' : 'translate-x-0.5'}`}
                                        />
                                    </div>
                                    <span className="text-[11px] text-gray-300">Delete from phone after upload</span>
                                </button>

                                {/* Download mode toggle */}
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => {
                                            triggerHaptic('light');
                                            setDownloadMode('phone-proxy');
                                        }}
                                        className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${
                                            downloadMode === 'phone-proxy'
                                                ? 'bg-sky-500/15 border border-sky-500/30 text-sky-400'
                                                : 'bg-white/[0.03] border border-white/[0.06] text-gray-500'
                                        }`}
                                    >
                                        📱 Via Phone
                                    </button>
                                    <button
                                        onClick={() => {
                                            triggerHaptic('light');
                                            setDownloadMode('pi-direct');
                                        }}
                                        className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${
                                            downloadMode === 'pi-direct'
                                                ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400'
                                                : 'bg-white/[0.03] border border-white/[0.06] text-gray-500'
                                        }`}
                                    >
                                        🖥 Pi Direct
                                    </button>
                                </div>
                                <p className="text-[11px] text-gray-500 leading-relaxed px-0.5">
                                    {!skConnected
                                        ? 'Not connected to AvNav — charts will be saved to your phone. Upload them later when connected.'
                                        : downloadMode === 'phone-proxy'
                                          ? 'Downloads chart to your phone first, then uploads to Pi. Works without Pi internet.'
                                          : 'Tells the Pi to download directly. Faster, but Pi needs internet access. Falls back to phone if unavailable.'}
                                </p>
                            </div>

                            {/* ── Free Chart Catalog ── */}
                            <div className="space-y-1">
                                <div className="flex items-center gap-2 mb-2">
                                    <p className="text-[11px] font-bold uppercase tracking-widest text-white/40 flex-1">
                                        Free Charts
                                    </p>
                                    <span className="text-[11px] text-emerald-400/60 font-mono bg-emerald-500/10 px-2 py-0.5 rounded-full">
                                        {catalog.length} charts
                                    </span>
                                </div>

                                {regions.map(({ region, label, count }) => (
                                    <div key={region}>
                                        <RegionHeader
                                            label={label}
                                            count={count}
                                            isExpanded={expandedRegions.has(region)}
                                            onToggle={() => toggleRegion(region)}
                                        />
                                        {expandedRegions.has(region) && (
                                            <div className="space-y-1 ml-1 mb-2">
                                                {catalog
                                                    .filter((pkg) => pkg.region === region)
                                                    .map((pkg) => (
                                                        <ChartPackageRow
                                                            key={pkg.id}
                                                            pkg={pkg}
                                                            isActive={activePackageId === pkg.id}
                                                            activeProgress={
                                                                activePackageId === pkg.id ? uploadProgress : null
                                                            }
                                                            onDownload={handleDownloadChart}
                                                        />
                                                    ))}
                                            </div>
                                        )}
                                    </div>
                                ))}

                                {!linzKey && (
                                    <p className="text-[11px] text-gray-500 text-center py-2 border-t border-white/[0.04] mt-2">
                                        Add a LINZ API key in Settings to see NZ charts
                                    </p>
                                )}
                            </div>

                            {/* ── Community Charts Credit ── */}
                            <div className="px-3 py-2.5 rounded-xl bg-sky-500/5 border border-sky-500/10">
                                <p className="text-[11px] font-bold text-sky-400 mb-1">
                                    ⛵ Community Charts — South Pacific
                                </p>
                                <p className="text-[11px] text-gray-400 leading-relaxed">
                                    Fiji, Tonga, Vanuatu, French Polynesia and more — satellite + Navionics overlays
                                    made by cruisers, for cruisers. Courtesy of{' '}
                                    <span className="text-sky-300 font-bold">Bruce Balan's Chart Locker</span>. Not
                                    official charts — use alongside proper navigation.
                                </p>
                                <p className="text-[11px] text-gray-500 mt-1">
                                    Downloads are automated — Thalassa resolves the links, downloads the zip, and
                                    uploads to your AvNav Pi. One tap. ☕
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                {/* ═══ SETUP GUIDE TRIGGER ═══ */}
                <button
                    onClick={() => setShowSetupGuide(true)}
                    className="mb-3 w-full flex items-center gap-3 p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.06] transition-all active:scale-[0.98]"
                >
                    <span className="text-xl">📋</span>
                    <div className="flex-1 text-left">
                        <span className="text-xs font-bold text-white">Setup Guide</span>
                        <span className="block text-[11px] text-gray-500">How to install AvNav on a Raspberry Pi</span>
                    </div>
                    <svg
                        className="w-4 h-4 text-white/30"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                </button>

                {/* ═══ SETUP GUIDE MODAL ═══ */}
                <ModalSheet isOpen={showSetupGuide} onClose={handleCloseGuide} title="AvNav Setup Guide">
                    <div className="space-y-5 text-[13px] text-gray-300 leading-relaxed -mt-1">
                        {/* What is AvNav */}
                        <div>
                            <p className="text-white/80">
                                <span className="text-sky-400 font-bold">AvNav</span> is free, open-source chart server
                                software that runs on a <span className="text-white font-bold">Raspberry Pi</span>{' '}
                                aboard your vessel. It serves nautical charts to Thalassa over Wi-Fi — including{' '}
                                <span className="text-emerald-400 font-bold">free NOAA/LINZ charts</span> and{' '}
                                <span className="text-amber-400 font-bold">paid o-charts</span>.
                            </p>
                            <p className="text-[11px] text-gray-500 mt-1.5">
                                Without AvNav running, chart overlays, the Chart Locker, and network scan features on
                                this page will not work.
                            </p>
                        </div>

                        {/* What you need */}
                        <div>
                            <h4 className="text-xs font-black uppercase tracking-widest text-white/60 mb-2">
                                What You Need
                            </h4>
                            <ul className="space-y-1.5 text-[12px]">
                                <li className="flex items-start gap-2">
                                    <span className="text-sky-400 mt-0.5">•</span>
                                    <span>
                                        A <span className="text-white font-bold">Raspberry Pi 4</span> (or 3B+) with
                                        power supply
                                    </span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-sky-400 mt-0.5">•</span>
                                    <span>
                                        A <span className="text-white font-bold">64 GB microSD card</span> (or larger)
                                    </span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-sky-400 mt-0.5">•</span>
                                    <span>A computer to flash the SD card (Windows, Mac, or Linux)</span>
                                </li>
                            </ul>
                        </div>

                        {/* Step-by-step */}
                        <div>
                            <h4 className="text-xs font-black uppercase tracking-widest text-white/60 mb-2">
                                Installation
                            </h4>
                            <div className="space-y-3">
                                {/* Step 1 */}
                                <div className="flex gap-3">
                                    <span className="shrink-0 w-6 h-6 rounded-full bg-sky-500/20 text-sky-400 text-xs font-black flex items-center justify-center">
                                        1
                                    </span>
                                    <div>
                                        <p className="text-white font-bold text-[12px]">Download the AvNav image</p>
                                        <p className="text-[11px] text-gray-400 mt-0.5">
                                            Get the latest <span className="text-white">AvNav Touch</span> image from{' '}
                                            <span className="text-sky-400 font-bold">avnav.de/en/install.html</span>
                                        </p>
                                        <p className="text-[11px] text-gray-500 mt-0.5">
                                            This is a complete Raspberry Pi OS with AvNav pre-installed.
                                        </p>
                                    </div>
                                </div>

                                {/* Step 2 */}
                                <div className="flex gap-3">
                                    <span className="shrink-0 w-6 h-6 rounded-full bg-sky-500/20 text-sky-400 text-xs font-black flex items-center justify-center">
                                        2
                                    </span>
                                    <div>
                                        <p className="text-white font-bold text-[12px]">
                                            Flash the image to your SD card
                                        </p>
                                        <p className="text-[11px] text-gray-400 mt-0.5">
                                            Use one of these free tools to write the image:
                                        </p>
                                        <div className="mt-1.5 space-y-1">
                                            <div className="flex items-center gap-2 text-[11px]">
                                                <span className="w-14 text-right text-gray-500 font-bold">Windows</span>
                                                <span className="text-emerald-400 font-bold">Raspberry Pi Imager</span>
                                                <span className="text-gray-600">or</span>
                                                <span className="text-emerald-400 font-bold">balenaEtcher</span>
                                            </div>
                                            <div className="flex items-center gap-2 text-[11px]">
                                                <span className="w-14 text-right text-gray-500 font-bold">Mac</span>
                                                <span className="text-emerald-400 font-bold">Raspberry Pi Imager</span>
                                                <span className="text-gray-600">or</span>
                                                <span className="text-emerald-400 font-bold">balenaEtcher</span>
                                            </div>
                                            <div className="flex items-center gap-2 text-[11px]">
                                                <span className="w-14 text-right text-gray-500 font-bold">Linux</span>
                                                <span className="text-emerald-400 font-bold">Raspberry Pi Imager</span>
                                                <span className="text-gray-600">or</span>
                                                <code className="text-emerald-400 font-bold text-[10px]">dd</code>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Step 3 */}
                                <div className="flex gap-3">
                                    <span className="shrink-0 w-6 h-6 rounded-full bg-sky-500/20 text-sky-400 text-xs font-black flex items-center justify-center">
                                        3
                                    </span>
                                    <div>
                                        <p className="text-white font-bold text-[12px]">
                                            Boot the Pi and connect to Wi-Fi
                                        </p>
                                        <p className="text-[11px] text-gray-400 mt-0.5">
                                            Insert the SD card, power on the Pi, and connect it to your boat&apos;s
                                            Wi-Fi network. AvNav starts automatically on boot.
                                        </p>
                                    </div>
                                </div>

                                {/* Step 4 */}
                                <div className="flex gap-3">
                                    <span className="shrink-0 w-6 h-6 rounded-full bg-sky-500/20 text-sky-400 text-xs font-black flex items-center justify-center">
                                        4
                                    </span>
                                    <div>
                                        <p className="text-white font-bold text-[12px]">Connect from Thalassa</p>
                                        <p className="text-[11px] text-gray-400 mt-0.5">
                                            Make sure your phone is on the same Wi-Fi, then tap{' '}
                                            <span className="text-sky-400 font-bold">Scan Network</span> above — or
                                            enter the Pi&apos;s IP address and port{' '}
                                            <span className="text-white font-bold">8080</span> manually.
                                        </p>
                                    </div>
                                </div>

                                {/* Step 5 */}
                                <div className="flex gap-3">
                                    <span className="shrink-0 w-6 h-6 rounded-full bg-sky-500/20 text-sky-400 text-xs font-black flex items-center justify-center">
                                        5
                                    </span>
                                    <div>
                                        <p className="text-white font-bold text-[12px]">Add your charts</p>
                                        <p className="text-[11px] text-gray-400 mt-0.5">
                                            Use the <span className="text-sky-400 font-bold">Chart Locker</span> to
                                            download free NOAA or LINZ charts, upload your own, or install{' '}
                                            <span className="text-amber-400 font-bold">o-charts</span> (paid) for
                                            premium coverage. Charts appear as map overlays in Thalassa.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Divider */}
                        <div className="border-t border-white/[0.06]" />

                        {/* Don't show again */}
                        <div className="flex items-center justify-between">
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={dontShowAgain}
                                    onChange={(e) => setDontShowAgain(e.target.checked)}
                                    className="w-4 h-4 rounded border-white/20 bg-white/5 text-sky-500 focus:ring-sky-500/30 focus:ring-offset-0"
                                />
                                <span className="text-[11px] text-gray-500">Don&apos;t show this on page load</span>
                            </label>
                            <button
                                onClick={handleCloseGuide}
                                className="px-4 py-1.5 rounded-xl text-xs font-bold uppercase tracking-widest bg-sky-500/15 border border-sky-500/30 text-sky-400 hover:bg-sky-500/25 transition-all active:scale-95"
                            >
                                Got It
                            </button>
                        </div>
                    </div>
                </ModalSheet>
            </div>
        </div>
    );
};
