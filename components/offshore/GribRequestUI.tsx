/**
 * GribRequestUI — Full GRIB download request panel.
 *
 * Features:
 * - Bounding box coordinates (linked to map overlay)
 * - Parameter checklist with live file size estimate
 * - Resolution & time step sliders
 * - Direct vs Iridium mode toggle
 * - Resumable download progress bar
 * - Saildocs email generation
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { GribRequest, GribParameter, GribBoundingBox, GribDownloadState } from '../../types';
import {
    GribRequestBuilder,
    GRIB_PARAMETERS,
    RESOLUTION_OPTIONS,
    TIME_STEP_OPTIONS,
    FORECAST_HOURS_OPTIONS,
} from '../../services/GribRequestBuilder';
import { SatLinkClient, type DownloadProgress } from '../../services/SatLinkClient';

interface GribRequestUIProps {
    /** Current user location for centering default bbox */
    userLat?: number;
    userLon?: number;
    /** External bbox from map overlay drag */
    bbox?: GribBoundingBox;
    /** Emit bbox changes back to map overlay */
    onBboxChange?: (bbox: GribBoundingBox) => void;
    /** Download mode preference */
    mode?: 'direct' | 'iridium';
}

export const GribRequestUI: React.FC<GribRequestUIProps> = ({
    userLat,
    userLon,
    bbox: externalBbox,
    onBboxChange,
    mode: initialMode = 'direct',
}) => {
    // ── Request state ──
    const [request, setRequest] = useState<GribRequest>(() =>
        GribRequestBuilder.createDefault(userLat, userLon)
    );
    const [downloadMode, setDownloadMode] = useState<'direct' | 'iridium'>(initialMode);

    // ── Download state ──
    const [downloadState, setDownloadState] = useState<GribDownloadState>(SatLinkClient.getState());
    const [progress, setProgress] = useState<DownloadProgress | null>(null);

    // Sync external bbox
    useEffect(() => {
        if (externalBbox) {
            setRequest(prev => ({ ...prev, bbox: externalBbox }));
        }
    }, [externalBbox]);

    // Subscribe to download events
    useEffect(() => {
        const unsub1 = SatLinkClient.onStatusChange(setDownloadState);
        const unsub2 = SatLinkClient.onProgress(setProgress);
        return () => { unsub1(); unsub2(); };
    }, []);

    // ── Derived values ──
    const estimatedSize = useMemo(() => GribRequestBuilder.estimateSize(request), [request]);
    const formattedSize = useMemo(() => GribRequestBuilder.formatSize(estimatedSize), [estimatedSize]);
    const gridInfo = useMemo(() => GribRequestBuilder.getGridInfo(request), [request]);
    const bboxErrors = useMemo(() => GribRequestBuilder.validateBBox(request.bbox), [request.bbox]);
    const saildocsString = useMemo(() => GribRequestBuilder.formatSaildocsRequest(request), [request]);

    // Size tier for color coding
    const sizeTier = estimatedSize < 50 * 1024 ? 'tiny' : estimatedSize < 200 * 1024 ? 'small' : estimatedSize < 1024 * 1024 ? 'medium' : 'large';
    const sizeColors = { tiny: 'text-emerald-400', small: 'text-sky-400', medium: 'text-amber-400', large: 'text-red-400' };
    const sizeBgColors = { tiny: 'bg-emerald-500/10 border-emerald-500/20', small: 'bg-sky-500/10 border-sky-500/20', medium: 'bg-amber-500/10 border-amber-500/20', large: 'bg-red-500/10 border-red-500/20' };

    // ── Handlers ──
    const toggleParam = (key: GribParameter) => {
        setRequest(prev => {
            const has = prev.parameters.includes(key);
            const params = has ? prev.parameters.filter(p => p !== key) : [...prev.parameters, key];
            // Always keep at least wind
            if (params.length === 0) params.push('wind');
            return { ...prev, parameters: params };
        });
    };

    const updateBbox = useCallback((field: keyof GribBoundingBox, value: string) => {
        const num = parseFloat(value);
        if (isNaN(num)) return;
        const newBbox = { ...request.bbox, [field]: num };
        setRequest(prev => ({ ...prev, bbox: newBbox }));
        onBboxChange?.(newBbox);
    }, [request.bbox, onBboxChange]);

    const handleDownload = () => {
        if (bboxErrors.length > 0) return;
        if (downloadMode === 'iridium') {
            // Open email client
            const uri = GribRequestBuilder.getSaildocsMailtoUri(request);
            window.location.href = uri;
        } else {
            // Direct download
            const url = GribRequestBuilder.buildDownloadUrl(request);
            SatLinkClient.startDownload(url, `grib_${request.model}_${request.resolution}`);
        }
    };

    const handlePauseResume = () => {
        if (downloadState.status === 'downloading') SatLinkClient.pause();
        else if (downloadState.status === 'paused') SatLinkClient.resume();
    };

    const isDownloading = downloadState.status === 'downloading' || downloadState.status === 'paused';

    return (
        <div className="w-full max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
            {/* Header */}
            <div className="mb-6">
                <div className="flex items-center gap-3 mb-2">
                    <div className="p-2.5 rounded-xl bg-gradient-to-br from-orange-500/20 to-red-500/20 border border-orange-500/30">
                        <svg className="w-5 h-5 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                        </svg>
                    </div>
                    <div>
                        <h2 className="text-lg font-black text-white tracking-wide">OFFSHORE WEATHER</h2>
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest">GRIB download for satellite connections</p>
                    </div>
                </div>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* ESTIMATED FILE SIZE — THE HERO METRIC */}
            {/* ═══════════════════════════════════════════ */}
            <div className={`border rounded-2xl p-4 mb-6 text-center ${sizeBgColors[sizeTier]}`}>
                <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1">Estimated Download</p>
                <p className={`text-3xl font-black tracking-tight ${sizeColors[sizeTier]}`}>{formattedSize}</p>
                <p className="text-[10px] text-gray-500 mt-1">
                    {gridInfo.totalPoints.toLocaleString()} grid points × {gridInfo.timeSteps} time steps × {request.parameters.length} params
                </p>
                {sizeTier === 'large' && (
                    <p className="text-[10px] text-red-400 font-bold mt-2">⚠️ Large file — reduce area or disable parameters</p>
                )}
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* MODE TOGGLE */}
            {/* ═══════════════════════════════════════════ */}
            <div className="flex bg-black/40 p-1 rounded-xl border border-white/10 mb-6">
                <button
                    onClick={() => setDownloadMode('direct')}
                    className={`flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${downloadMode === 'direct' ? 'bg-sky-600 text-white shadow-lg shadow-sky-500/30' : 'text-gray-400 hover:text-white'
                        }`}
                >
                    📡 Direct Download
                </button>
                <button
                    onClick={() => setDownloadMode('iridium')}
                    className={`flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${downloadMode === 'iridium' ? 'bg-orange-600 text-white shadow-lg shadow-orange-500/30' : 'text-gray-400 hover:text-white'
                        }`}
                >
                    📧 Iridium Email
                </button>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* BOUNDING BOX */}
            {/* ═══════════════════════════════════════════ */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4 mb-4">
                <div className="flex items-center gap-2 mb-4">
                    <div className="w-1 h-4 rounded-full bg-sky-500" />
                    <span className="text-[10px] font-bold text-sky-400 uppercase tracking-widest">Download Area</span>
                    <span className="text-[9px] text-gray-500 ml-auto">Drag corners on map to adjust</span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    {(['north', 'south', 'west', 'east'] as const).map(field => (
                        <div key={field}>
                            <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{field}</label>
                            <input
                                type="number"
                                step="0.5"
                                value={request.bbox[field]}
                                onChange={e => updateBbox(field, e.target.value)}
                                className="w-full mt-1 bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono outline-none focus:border-sky-500 transition-colors"
                            />
                        </div>
                    ))}
                </div>

                {bboxErrors.length > 0 && (
                    <div className="mt-3 p-2 bg-red-500/10 border border-red-500/20 rounded-xl">
                        {bboxErrors.map((e, i) => (
                            <p key={i} className="text-[10px] text-red-400">⚠️ {e}</p>
                        ))}
                    </div>
                )}

                {/* Area info */}
                <div className="flex gap-4 mt-3 text-[10px] text-gray-500">
                    <span>{Math.abs(request.bbox.north - request.bbox.south).toFixed(1)}° lat span</span>
                    <span>{Math.abs(request.bbox.east - request.bbox.west).toFixed(1)}° lon span</span>
                    <span>{gridInfo.latPoints}×{gridInfo.lonPoints} = {gridInfo.totalPoints.toLocaleString()} points</span>
                </div>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* PARAMETER CHECKLIST */}
            {/* ═══════════════════════════════════════════ */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4 mb-4">
                <div className="flex items-center gap-2 mb-4">
                    <div className="w-1 h-4 rounded-full bg-emerald-500" />
                    <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest">Data Parameters</span>
                </div>

                <div className="space-y-2">
                    {GRIB_PARAMETERS.map(param => {
                        const active = request.parameters.includes(param.key);
                        const paramSize = gridInfo.totalPoints * gridInfo.timeSteps * param.bytesPerPoint + 200 * gridInfo.timeSteps;
                        return (
                            <button
                                key={param.key}
                                onClick={() => toggleParam(param.key)}
                                className={`w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all ${active
                                        ? 'bg-emerald-500/10 border border-emerald-500/20'
                                        : 'bg-white/[0.02] border border-white/5 opacity-50'
                                    }`}
                            >
                                {/* Checkbox */}
                                <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-all ${active ? 'bg-emerald-500 border-emerald-500' : 'border-gray-600'
                                    }`}>
                                    {active && (
                                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                        </svg>
                                    )}
                                </div>

                                <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-bold text-white">{param.label}</span>
                                        {param.essential && (
                                            <span className="text-[8px] font-bold text-sky-400 bg-sky-500/10 px-1.5 py-0.5 rounded">ESSENTIAL</span>
                                        )}
                                    </div>
                                    <p className="text-[10px] text-gray-500">{param.description}</p>
                                </div>

                                {/* Size impact */}
                                <span className={`text-[10px] font-mono font-bold flex-shrink-0 ${active ? 'text-emerald-400' : 'text-gray-600'}`}>
                                    +{GribRequestBuilder.formatSize(paramSize)}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* RESOLUTION & TIME */}
            {/* ═══════════════════════════════════════════ */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4 mb-4">
                <div className="flex items-center gap-2 mb-4">
                    <div className="w-1 h-4 rounded-full bg-amber-500" />
                    <span className="text-[10px] font-bold text-amber-400 uppercase tracking-widest">Resolution & Timing</span>
                </div>

                {/* Resolution */}
                <div className="mb-4">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Grid Resolution</p>
                    <div className="flex gap-2">
                        {RESOLUTION_OPTIONS.map(opt => (
                            <button
                                key={opt.value}
                                onClick={() => setRequest(prev => ({ ...prev, resolution: opt.value }))}
                                className={`flex-1 py-2.5 rounded-xl text-center transition-all border ${request.resolution === opt.value
                                        ? 'bg-amber-500/15 border-amber-500/30 text-white'
                                        : 'border-white/5 text-gray-400 hover:border-white/10'
                                    }`}
                            >
                                <p className="text-sm font-black">{opt.label}</p>
                                <p className="text-[9px] text-gray-500 mt-0.5">{opt.description}</p>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Time step */}
                <div className="mb-4">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Forecast Interval</p>
                    <div className="flex gap-2">
                        {TIME_STEP_OPTIONS.map(opt => (
                            <button
                                key={opt.value}
                                onClick={() => setRequest(prev => ({ ...prev, timeStep: opt.value }))}
                                className={`flex-1 py-2.5 rounded-xl text-center transition-all border ${request.timeStep === opt.value
                                        ? 'bg-amber-500/15 border-amber-500/30 text-white'
                                        : 'border-white/5 text-gray-400 hover:border-white/10'
                                    }`}
                            >
                                <p className="text-sm font-bold">{opt.label}</p>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Forecast hours */}
                <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Forecast Span</p>
                    <div className="flex gap-2">
                        {FORECAST_HOURS_OPTIONS.map(opt => (
                            <button
                                key={opt.value}
                                onClick={() => setRequest(prev => ({ ...prev, forecastHours: opt.value }))}
                                className={`flex-1 py-2.5 rounded-xl text-center transition-all border ${request.forecastHours === opt.value
                                        ? 'bg-amber-500/15 border-amber-500/30 text-white'
                                        : 'border-white/5 text-gray-400 hover:border-white/10'
                                    }`}
                            >
                                <p className="text-sm font-bold">{opt.label}</p>
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* MODEL SELECTOR */}
            {/* ═══════════════════════════════════════════ */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4 mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-4 rounded-full bg-violet-500" />
                    <span className="text-[10px] font-bold text-violet-400 uppercase tracking-widest">Weather Model</span>
                </div>
                <div className="flex gap-2">
                    {(['GFS', 'ECMWF'] as const).map(model => (
                        <button
                            key={model}
                            onClick={() => setRequest(prev => ({ ...prev, model }))}
                            className={`flex-1 py-3 rounded-xl text-center transition-all border ${request.model === model
                                    ? 'bg-violet-500/15 border-violet-500/30 text-white'
                                    : 'border-white/5 text-gray-400 hover:border-white/10'
                                }`}
                        >
                            <p className="text-sm font-black">{model}</p>
                            <p className="text-[9px] text-gray-500">{model === 'GFS' ? 'NOAA • Free' : 'European • Premium'}</p>
                        </button>
                    ))}
                </div>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* IRIDIUM SAILDOCS PREVIEW */}
            {/* ═══════════════════════════════════════════ */}
            {downloadMode === 'iridium' && (
                <div className="bg-orange-500/5 border border-orange-500/20 rounded-2xl p-4 mb-6">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-orange-500" />
                        <span className="text-[10px] font-bold text-orange-400 uppercase tracking-widest">Saildocs Command</span>
                    </div>
                    <div className="bg-black/40 rounded-xl p-3 font-mono text-xs text-orange-300 break-all select-all">
                        {saildocsString}
                    </div>
                    <p className="text-[9px] text-gray-500 mt-2">
                        This will be emailed to query@saildocs.com. The GRIB file will be returned via email.
                    </p>
                </div>
            )}

            {/* ═══════════════════════════════════════════ */}
            {/* DOWNLOAD PROGRESS */}
            {/* ═══════════════════════════════════════════ */}
            {isDownloading && progress && (
                <div className="bg-sky-500/5 border border-sky-500/20 rounded-2xl p-4 mb-6">
                    <div className="flex items-center justify-between mb-3">
                        <span className="text-[10px] font-bold text-sky-400 uppercase tracking-widest">
                            {downloadState.status === 'paused' ? '⏸ Paused' : '📡 Downloading…'}
                        </span>
                        <span className="text-sm font-black text-white">{progress.percent}%</span>
                    </div>

                    {/* Progress bar */}
                    <div className="w-full h-2 bg-black/40 rounded-full overflow-hidden mb-2">
                        <div
                            className={`h-full rounded-full transition-all duration-300 ${downloadState.status === 'paused' ? 'bg-amber-500' : 'bg-sky-500'
                                }`}
                            style={{ width: `${progress.percent}%` }}
                        />
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-gray-500">
                        <span>
                            {GribRequestBuilder.formatSize(progress.downloadedBytes)} / {GribRequestBuilder.formatSize(progress.totalBytes)}
                        </span>
                        <span>
                            {progress.speedBps > 0 ? `${GribRequestBuilder.formatSize(progress.speedBps)}/s` : '—'}
                            {progress.estimatedRemainingS > 0 && ` • ${Math.ceil(progress.estimatedRemainingS)}s remaining`}
                        </span>
                    </div>

                    {/* Pause/Resume/Cancel */}
                    <div className="flex gap-2 mt-3">
                        <button
                            onClick={handlePauseResume}
                            className={`flex-1 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all ${downloadState.status === 'paused'
                                    ? 'bg-sky-600 text-white'
                                    : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                }`}
                        >
                            {downloadState.status === 'paused' ? '▶ Resume' : '⏸ Pause'}
                        </button>
                        <button
                            onClick={() => SatLinkClient.cancel()}
                            className="px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-all"
                        >
                            ✕ Cancel
                        </button>
                    </div>
                </div>
            )}

            {/* Download complete */}
            {downloadState.status === 'complete' && (
                <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-4 mb-6 text-center">
                    <p className="text-lg font-black text-emerald-400">✅ Download Complete</p>
                    <p className="text-[10px] text-gray-500 mt-1">
                        {GribRequestBuilder.formatSize(downloadState.totalBytes)} saved to device
                    </p>
                </div>
            )}

            {/* Download error */}
            {downloadState.status === 'error' && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-4 mb-6">
                    <p className="text-sm font-bold text-red-400">⚠️ {downloadState.errorMessage || 'Download failed'}</p>
                    <p className="text-[10px] text-gray-500 mt-1">Auto-retrying with exponential backoff…</p>
                </div>
            )}

            {/* ═══════════════════════════════════════════ */}
            {/* ACTION BUTTON */}
            {/* ═══════════════════════════════════════════ */}
            {!isDownloading && downloadState.status !== 'complete' && (
                <button
                    onClick={handleDownload}
                    disabled={bboxErrors.length > 0}
                    className={`w-full py-4 rounded-2xl text-sm font-black uppercase tracking-widest transition-all ${bboxErrors.length > 0
                            ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                            : downloadMode === 'iridium'
                                ? 'bg-gradient-to-r from-orange-600 to-red-600 text-white shadow-xl shadow-orange-500/20 hover:shadow-orange-500/40'
                                : 'bg-gradient-to-r from-sky-600 to-cyan-600 text-white shadow-xl shadow-sky-500/20 hover:shadow-sky-500/40'
                        }`}
                >
                    {downloadMode === 'iridium'
                        ? `📧 Open Saildocs Email (${formattedSize})`
                        : `📡 Download GRIB (${formattedSize})`
                    }
                </button>
            )}
        </div>
    );
};
