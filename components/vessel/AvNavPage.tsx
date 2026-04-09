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
    const [skPort, setSkPort] = useState(String(AvNavService.getPort()));
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

    // LINZ key from localStorage (same as ChartCatalogService)
    const linzKey = typeof localStorage !== 'undefined' ? localStorage.getItem('thalassa_linz_api_key') : null;

    // Build catalog
    const catalog = useMemo(() => ChartLockerService.getFullCatalog(linzKey), [linzKey]);
    const regions = useMemo(() => ChartLockerService.getRegions(catalog), [catalog]);

    useEffect(() => {
        const unsubSk = AvNavService.onStatusChange((s) => {
            setSkStatus(s);
            setSkApiVersion(AvNavService.getApiVersion());
            setSkLastError(AvNavService.getLastError());
        });
        const unsubSkCharts = AvNavService.onChartsChange((c) => setSkCharts(c));
        const unsubScanStatus = AvNavDiscoveryService.onStatusChange(setScanStatus);
        const unsubScanServers = AvNavDiscoveryService.onServersChange(setFoundServers);

        return () => {
            unsubSk();
            unsubSkCharts();
            unsubScanStatus();
            unsubScanServers();
        };
    }, []);

    const handleSkConnect = useCallback(() => {
        triggerHaptic('medium');
        AvNavService.configure(skHost, parseInt(skPort, 10) || 3000, 'avnav');
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
        await ChartLockerService.pickAndUpload(
            skHost,
            parseInt(skPort, 10) || 8080,
            deleteAfterUpload,
            setUploadProgress,
        );
    }, [skHost, skPort, deleteAfterUpload]);

    const handleDownloadChart = useCallback(
        async (pkg: ChartPackage) => {
            triggerHaptic('medium');
            setActivePackageId(pkg.id);
            setUploadProgress(null);

            await ChartLockerService.downloadChart(
                pkg,
                downloadMode,
                skHost,
                parseInt(skPort, 10) || 8080,
                deleteAfterUpload,
                setUploadProgress,
            );
        },
        [downloadMode, skHost, skPort, deleteAfterUpload],
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
                            <p className="text-[11px] text-gray-400">
                                Upload charts to AvNav · Free NOAA & LINZ charts
                            </p>
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
                            {/* ── Upload from Phone ── */}
                            <div className="space-y-2">
                                <p className="text-[11px] font-bold uppercase tracking-widest text-white/40">
                                    Upload From Phone
                                </p>
                                <p className="text-[11px] text-gray-500 leading-relaxed">
                                    Select chart files from your phone to install on AvNav. Supports{' '}
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
                                    disabled={!skConnected || isBusy}
                                    className={`w-full py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all active:scale-95 ${
                                        !skConnected
                                            ? 'bg-white/[0.03] border border-white/[0.06] text-gray-500 cursor-not-allowed'
                                            : isBusy
                                              ? 'bg-amber-500/10 border border-amber-500/20 text-amber-400 cursor-not-allowed'
                                              : 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25'
                                    }`}
                                >
                                    {!skConnected ? (
                                        '🔗 Connect to AvNav First'
                                    ) : isBusy ? (
                                        <span className="flex items-center justify-center gap-2">
                                            <span className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                                            Working…
                                        </span>
                                    ) : (
                                        '📂 Select Chart File'
                                    )}
                                </button>
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
                                    {downloadMode === 'phone-proxy'
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

                            {/* ── o-Charts Info ── */}
                            <div className="px-3 py-2.5 rounded-xl bg-amber-500/5 border border-amber-500/10">
                                <p className="text-[11px] font-bold text-amber-400 mb-1">🔐 o-Charts (DRM)</p>
                                <p className="text-[11px] text-gray-400 leading-relaxed">
                                    Upload <span className="font-mono text-amber-300">.oesenc</span> files purchased
                                    from <span className="text-amber-400">o-charts.org</span>. Requires a USB dongle
                                    connected to your AvNav Pi for decryption. Use the{' '}
                                    <span className="text-emerald-400 font-bold">Upload From Phone</span> button above.
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                {/* ═══ SETUP GUIDE ═══ */}
                <div className="mb-3 p-4 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                    <h3 className="text-sm font-bold text-white mb-2">📋 Quick Setup Guide</h3>
                    <div className="space-y-2 text-[11px] text-gray-400 leading-relaxed">
                        <p>
                            <span className="text-white font-bold">1.</span> Install AvNav on a Raspberry Pi or laptop
                            aboard your vessel
                        </p>
                        <p>
                            <span className="text-white font-bold">2.</span> Connect your device to the same Wi-Fi
                            network as your AvNav server
                        </p>
                        <p>
                            <span className="text-white font-bold">3.</span> Tap{' '}
                            <span className="text-sky-400 font-bold">Scan Network</span> above or enter the server IP
                            manually
                        </p>
                        <p>
                            <span className="text-white font-bold">4.</span> Use the{' '}
                            <span className="text-sky-400 font-bold">Chart Locker</span> to download free NOAA/LINZ
                            charts or upload your own
                        </p>
                        <p className="text-[11px] text-gray-500 pt-1 border-t border-white/[0.04]">
                            Charts will appear as map overlays. Toggle them in the map layer panel.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};
