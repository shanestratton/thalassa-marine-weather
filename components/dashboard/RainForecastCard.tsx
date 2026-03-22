import React, { useMemo, useState, useCallback, useEffect } from 'react';

interface MinutelyRain {
    time: string;
    intensity: number; // mm/hr
}

interface RainForecastCardProps {
    data: MinutelyRain[];
    className?: string;
    timeZone?: string;
    rainSummary?: string; // Apple's native summary (e.g. "Rain starting in 15 min")
}

/**
 * RainForecastCard — Progressive Disclosure Rain Component
 *
 * Compact State: Small card with summary text. "Wakes up" with cyan glow when rain detected.
 * Expanded State: Full modal with Dark Sky-style 60-bar minute-by-minute precipitation chart.
 */
export const RainForecastCard: React.FC<RainForecastCardProps> = ({
    data,
    className = '',
    timeZone: _timeZone,
    rainSummary,
}) => {
    const [isModalOpen, setIsModalOpen] = useState(false);

    // 60-second tick — forces re-evaluation of "Rain in X min" countdown
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick((t) => t + 1), 60_000);
        return () => clearInterval(id);
    }, []);

    const analysis = useMemo(() => {
        if (!data || data.length === 0)
            return {
                maxIntensity: 0,
                hasRain: false,
                headline: 'No Rain Expected',
                subline: 'Next 60 minutes',
                isCurrentlyRaining: false,
                category: { label: 'Clear', badgeClass: '', color: 'rgba(96, 165, 250, 0.5)' },
                totalPrecip: 0,
                firstRainIdx: -1,
                peakIdx: 0,
            };

        const now = Date.now();

        // Filter out entries whose time has already elapsed — keeps analysis current
        // between data refreshes
        const futureData = data.filter((d) => new Date(d.time).getTime() > now - 60_000);
        const workingData = futureData.length > 0 ? futureData : data;

        const maxIntensity = Math.max(...workingData.map((d) => d.intensity), 0.1);

        // DATA ALWAYS WINS: determine rain from actual minute-by-minute intensities.
        const RAIN_THRESHOLD = 0.1; // mm/hr — ignore trace amounts below this
        const hasRain = workingData.some((d) => d.intensity >= RAIN_THRESHOLD);
        const firstRainEntry = workingData.find((d) => d.intensity >= RAIN_THRESHOLD);
        const firstRainIdx = workingData.findIndex((d) => d.intensity >= RAIN_THRESHOLD);
        const isCurrentlyRaining = (workingData[0]?.intensity ?? 0) >= RAIN_THRESHOLD;

        // Compute real minutes-until-rain using actual timestamps
        const minutesUntilRain = firstRainEntry
            ? Math.max(1, Math.round((new Date(firstRainEntry.time).getTime() - now) / 60_000))
            : -1;

        // Find first dry minute after rain
        const firstDryAfterRain = isCurrentlyRaining
            ? (() => {
                  const dryEntry = workingData.find((d, i) => i > 0 && d.intensity < RAIN_THRESHOLD);
                  if (!dryEntry) return -1;
                  return Math.max(1, Math.round((new Date(dryEntry.time).getTime() - now) / 60_000));
              })()
            : -1;

        // Peak intensity index
        const peakIdx = workingData.reduce((maxI, d, i) => (d.intensity > workingData[maxI].intensity ? i : maxI), 0);

        // Total precipitation in the hour (mm)
        const totalPrecip = workingData.reduce((sum, d) => sum + d.intensity / 60, 0);

        // Headline logic — generate from data, use Apple summary only as flavour text
        let headline = '';
        let subline = '';

        if (!hasRain) {
            headline = rainSummary || 'No Rain Expected';
            subline = 'Next 60 minutes';
        } else if (isCurrentlyRaining && firstDryAfterRain > 0) {
            headline = `Rain stopping in ${firstDryAfterRain} min`;
            subline = getIntensityLabel(workingData[0].intensity);
        } else if (isCurrentlyRaining && firstDryAfterRain === -1) {
            headline = 'Rain for the next hour';
            subline = getIntensityLabel(maxIntensity);
        } else if (minutesUntilRain > 0) {
            headline = `Rain in ${minutesUntilRain} min`;
            subline = getIntensityLabel(firstRainEntry!.intensity);
        } else if (rainSummary && !(/\bno\b/i.test(rainSummary) && /rain|precip/i.test(rainSummary))) {
            headline = rainSummary;
            subline = `Peak: ${Math.round(maxIntensity)} mm/hr`;
        } else {
            headline = 'Precipitation detected';
            subline = `Peak: ${Math.round(maxIntensity)} mm/hr`;
        }

        const category = getIntensityCategory(maxIntensity);

        return {
            maxIntensity,
            hasRain,
            firstRainIdx,
            isCurrentlyRaining,
            headline,
            subline,
            category,
            totalPrecip,
            peakIdx,
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data, rainSummary, tick]); // tick forces re-evaluation every 60s

    // Close modal on ESC
    useEffect(() => {
        if (!isModalOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setIsModalOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isModalOpen]);

    const openModal = useCallback(() => {
        if (data && data.length > 0) setIsModalOpen(true);
    }, [data]);

    if (!analysis) return null;

    // --- COMPACT CARD (always visible) ---
    const isActive = analysis.hasRain;

    return (
        <>
            <button
                aria-label="Modal"
                onClick={openModal}
                className={`w-full rounded-xl overflow-hidden relative text-left transition-all duration-500 ${className} ${
                    isActive
                        ? 'bg-sky-900/40 border border-cyan-400/30 shadow-lg shadow-cyan-500/10'
                        : 'bg-slate-800/40 border border-blue-400/10'
                }`}
                style={{
                    minHeight: '76px',
                }}
            >
                {/* Rain glow animation when active */}
                {isActive && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl">
                        <div className="absolute -top-8 left-1/3 w-24 h-24 bg-sky-500/10 rounded-full blur-3xl" />
                        <div className="absolute -bottom-4 right-1/4 w-16 h-16 bg-sky-500/10 rounded-full blur-2xl" />
                    </div>
                )}

                <div className="relative z-10 px-3 py-1.5 h-full flex flex-col justify-between">
                    {/* Header Row */}
                    <div className="flex items-center justify-center">
                        <div className="flex items-center gap-1.5">
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                className={isActive ? 'text-sky-400' : 'text-sky-400/60'}
                            >
                                <path
                                    d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0L12 2.69z"
                                    fill="currentColor"
                                    fillOpacity={isActive ? '0.5' : '0.3'}
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                />
                            </svg>
                            <span
                                className={`text-xs font-bold uppercase tracking-wider ${isActive ? 'text-sky-300' : 'text-ivory'}`}
                            >
                                {analysis.headline}
                            </span>
                        </div>

                        {isActive && (
                            <div
                                className={`px-1.5 py-0 rounded-full text-[11px] font-bold uppercase tracking-wide leading-tight ${analysis.category.badgeClass}`}
                            >
                                {analysis.category.label}
                            </div>
                        )}
                    </div>

                    {/* Mini Bar Chart (compact preview) — only show when there is meaningful rain */}
                    {data && data.length > 0 && analysis.hasRain && (
                        <div className="flex items-end gap-[1px] w-full mt-1 h-[22px]">
                            {data.map((point, i) => {
                                const normalizedHeight =
                                    analysis.maxIntensity > 0
                                        ? Math.max(
                                              (point.intensity / analysis.maxIntensity) * 100,
                                              point.intensity > 0 ? 10 : 0,
                                          )
                                        : 0;
                                const barColor = getBarColor(point.intensity, analysis.maxIntensity, isActive);

                                return (
                                    <div key={i} className="flex-1 relative" style={{ height: '100%' }}>
                                        <div
                                            className="absolute bottom-0 left-0 right-0 rounded-t-[1px]"
                                            style={{
                                                height: `${normalizedHeight}%`,
                                                background: barColor,
                                                minWidth: '1px',
                                                boxShadow: point.intensity > 0 ? `0 0 3px ${barColor}30` : 'none',
                                            }}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* Tap hint */}
                    {data && data.length > 0 && (
                        <div className="flex items-center justify-center mt-0.5">
                            <span className="text-[11px] font-bold text-white/60 uppercase tracking-widest">
                                Tap for detail
                            </span>
                        </div>
                    )}
                </div>
            </button>

            {/* Expanded Modal */}
            {isModalOpen && <RainModal data={data} analysis={analysis} onClose={() => setIsModalOpen(false)} />}
        </>
    );
};

// --- EXPANDED MODAL ---

interface ModalProps {
    data: MinutelyRain[];
    analysis: {
        maxIntensity: number;
        hasRain: boolean;
        headline: string;
        subline: string;
        category: { label: string; badgeClass: string; color: string };
        totalPrecip: number;
        peakIdx: number;
        isCurrentlyRaining: boolean;
    };
    onClose: () => void;
}

const RainModal: React.FC<ModalProps> = ({ data, analysis, onClose }) => {
    // Prevent body scroll when modal is open
    useEffect(() => {
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = '';
        };
    }, []);

    // Time labels
    const timeLabels = [
        { min: 0, label: 'NOW' },
        { min: 15, label: '15M' },
        { min: 30, label: '30M' },
        { min: 45, label: '45M' },
        { min: 59, label: '60M' },
    ];

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-6" onClick={onClose}>
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/80" />

            {/* Modal */}
            <div
                className="relative w-full max-w-md rounded-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
                style={{
                    background:
                        'linear-gradient(180deg, rgba(6, 78, 115, 0.9) 0%, rgba(15, 23, 42, 0.95) 40%, rgba(8, 51, 96, 0.85) 100%)',
                    border: '1px solid rgba(34, 211, 238, 0.2)',
                    boxShadow: '0 0 60px -10px rgba(34, 211, 238, 0.15), 0 25px 50px -12px rgba(0,0,0,0.5)',
                }}
            >
                {/* Weather-themed background imagery */}
                <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl">
                    {/* Glow effects */}
                    <div className="absolute -top-20 left-1/4 w-40 h-40 bg-sky-500/10 rounded-full blur-3xl" />
                    <div className="absolute -bottom-10 right-1/3 w-32 h-32 bg-sky-500/10 rounded-full blur-3xl" />

                    {/* Subtle weather scene */}
                    {!analysis.hasRain ? (
                        /* ☀️ Clear — subtle warm glow */
                        <>
                            <div
                                className="absolute top-4 right-8 w-16 h-16 rounded-full opacity-[0.06]"
                                style={{
                                    background:
                                        'radial-gradient(circle, rgba(250,204,21,0.8) 0%, rgba(250,204,21,0) 70%)',
                                }}
                            />
                            <svg
                                className="absolute top-2 right-6 w-20 h-20 opacity-[0.05] text-yellow-300"
                                viewBox="0 0 100 100"
                            >
                                <circle cx="50" cy="50" r="18" fill="currentColor" />
                                {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
                                    <line
                                        key={angle}
                                        x1="50"
                                        y1="50"
                                        x2={50 + 30 * Math.cos((angle * Math.PI) / 180)}
                                        y2={50 + 30 * Math.sin((angle * Math.PI) / 180)}
                                        stroke="currentColor"
                                        strokeWidth="3"
                                        strokeLinecap="round"
                                    />
                                ))}
                            </svg>
                        </>
                    ) : analysis.maxIntensity < 2.5 ? (
                        /* 🌧️ Light rain — static subtle droplets (no infinite animations) */
                        <svg className="absolute inset-0 w-full h-full opacity-[0.06]" viewBox="0 0 200 400">
                            {[
                                { x: 30, y: 60 },
                                { x: 70, y: 120 },
                                { x: 120, y: 40 },
                                { x: 160, y: 100 },
                                { x: 50, y: 200 },
                                { x: 140, y: 180 },
                                { x: 90, y: 280 },
                                { x: 170, y: 250 },
                                { x: 25, y: 320 },
                            ].map((drop, i) => (
                                <line
                                    key={i}
                                    x1={drop.x}
                                    y1={drop.y}
                                    x2={drop.x - 2}
                                    y2={drop.y + 14}
                                    stroke="rgba(56,189,248,1)"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    opacity="0.8"
                                />
                            ))}
                        </svg>
                    ) : (
                        /* ⛈️ Heavy rain — dense drops + cloud silhouette */
                        <>
                            <svg
                                className="absolute top-0 left-0 w-full opacity-[0.06]"
                                viewBox="0 0 300 80"
                                preserveAspectRatio="xMidYMin slice"
                            >
                                <path
                                    d="M-10 80 Q30 20 80 40 Q120 10 160 35 Q200 5 240 30 Q270 15 310 50 L310 80Z"
                                    fill="rgba(148,163,184,0.8)"
                                />
                                <path
                                    d="M-10 80 Q40 30 90 50 Q130 20 170 45 Q210 15 250 40 Q280 25 310 55 L310 80Z"
                                    fill="rgba(100,116,139,0.6)"
                                />
                            </svg>
                            <svg className="absolute inset-0 w-full h-full opacity-[0.08]" viewBox="0 0 200 400">
                                {Array.from({ length: 18 }, (_, i) => ({
                                    x: 10 + ((i * 11) % 190),
                                    y: 20 + ((i * 37) % 300),
                                })).map((drop, i) => (
                                    <line
                                        key={i}
                                        x1={drop.x}
                                        y1={drop.y}
                                        x2={drop.x - 3}
                                        y2={drop.y + 18}
                                        stroke="rgba(56,189,248,0.9)"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                    />
                                ))}
                            </svg>
                        </>
                    )}
                </div>

                <div className="relative z-10 p-5">
                    {/* Header */}
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-sky-400">
                                <path
                                    d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0L12 2.69z"
                                    fill="currentColor"
                                    fillOpacity="0.4"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                />
                            </svg>
                            <h3 className="text-sm font-bold text-white uppercase tracking-wider">Rain Forecast</h3>
                        </div>
                        <button
                            onClick={onClose}
                            className="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-colors"
                            aria-label="Close"
                        >
                            <span className="text-white/70 text-sm">✕</span>
                        </button>
                    </div>

                    {/* Intensity Gauge */}
                    <div className="flex flex-col items-center mb-5">
                        <div className="relative w-36 h-20">
                            <svg viewBox="0 0 120 65" className="w-full h-full overflow-visible">
                                {/* Background arc */}
                                <path
                                    d="M 10 60 A 50 50 0 0 1 110 60"
                                    fill="none"
                                    stroke="rgba(255,255,255,0.08)"
                                    strokeWidth="8"
                                    strokeLinecap="round"
                                />
                                {/* Active arc — proportional to intensity */}
                                {analysis.hasRain && (
                                    <path
                                        d="M 10 60 A 50 50 0 0 1 110 60"
                                        fill="none"
                                        stroke="url(#rainGaugeGrad)"
                                        strokeWidth="8"
                                        strokeLinecap="round"
                                        strokeDasharray={`${Math.min(analysis.maxIntensity / 15, 1) * 157} 157`}
                                    />
                                )}
                                <defs>
                                    <linearGradient id="rainGaugeGrad" x1="0" y1="0" x2="1" y2="0">
                                        <stop offset="0%" stopColor="#22d3ee" />
                                        <stop offset="50%" stopColor="#3b82f6" />
                                        <stop offset="100%" stopColor="#818cf8" />
                                    </linearGradient>
                                </defs>
                                {/* Droplet icon */}
                                <path
                                    d="M 60 28 l3.5 3.5 a5 5 0 1 1 -7 0 L60 28z"
                                    fill="rgba(34, 211, 238, 0.7)"
                                    stroke="rgba(34, 211, 238, 0.9)"
                                    strokeWidth="0.5"
                                />
                            </svg>
                        </div>

                        {/* Intensity label */}
                        <div className="text-center -mt-2">
                            <div
                                className={`text-[11px] font-bold uppercase tracking-widest mb-0.5 ${analysis.hasRain ? 'text-sky-400' : 'text-sky-400/50'}`}
                            >
                                {analysis.hasRain ? getIntensityLabel(analysis.maxIntensity) : 'Clear'}
                            </div>
                            <div className="text-2xl font-black text-white tabular-nums">
                                {analysis.hasRain ? analysis.maxIntensity.toFixed(1) : '0.0'}
                            </div>
                            <div className="text-[11px] text-white/60 uppercase tracking-wider">mm/hr peak</div>
                        </div>
                    </div>

                    {/* Summary Text */}
                    <div className="text-center mb-4">
                        <p className="text-sm font-bold text-white uppercase tracking-wide">{analysis.headline}</p>
                    </div>

                    {/* 60-Bar Chart */}
                    <div className="relative">
                        {/* Peak intensity marker */}
                        {analysis.hasRain && (
                            <div
                                className="absolute -top-4 text-[11px] text-sky-400 font-bold uppercase tracking-wider whitespace-nowrap"
                                style={{
                                    left: `${(analysis.peakIdx / Math.max(data.length - 1, 1)) * 100}%`,
                                    transform: 'translateX(-50%)',
                                }}
                            >
                                Peak
                            </div>
                        )}

                        <div className="flex items-end gap-[2px] w-full h-[120px]">
                            {data.map((point, i) => {
                                const normalizedHeight =
                                    analysis.maxIntensity > 0
                                        ? Math.max(
                                              (point.intensity / analysis.maxIntensity) * 100,
                                              point.intensity > 0 ? 8 : 0,
                                          )
                                        : 0;
                                const barColor = getBarColor(point.intensity, analysis.maxIntensity, true);
                                const isPeak = i === analysis.peakIdx && analysis.hasRain;

                                return (
                                    <div key={i} className="flex-1 relative" style={{ height: '100%' }}>
                                        <div
                                            className={`absolute bottom-0 left-0 right-0 rounded-t-sm transition-all duration-300 ${isPeak ? 'ring-1 ring-cyan-400/50' : ''}`}
                                            style={{
                                                height: `${normalizedHeight}%`,
                                                background: barColor,
                                                minWidth: '2px',
                                                boxShadow:
                                                    point.intensity > 0
                                                        ? `0 0 ${isPeak ? '8' : '3'}px ${barColor}50`
                                                        : 'none',
                                            }}
                                        />
                                    </div>
                                );
                            })}
                        </div>

                        {/* Time Axis */}
                        <div className="flex justify-between mt-2 px-0">
                            {timeLabels.map(({ min, label }) => (
                                <span
                                    key={min}
                                    className="text-[11px] text-white/60 font-bold uppercase tracking-wider"
                                >
                                    {label}
                                </span>
                            ))}
                        </div>
                    </div>

                    {/* Stats Row */}
                    {analysis.hasRain && (
                        <div className="grid grid-cols-3 gap-3 mt-4 pt-3 border-t border-white/10">
                            <div className="text-center">
                                <div className="text-[11px] text-white/60 uppercase tracking-wider mb-0.5">Total</div>
                                <div className="text-sm font-bold text-white tabular-nums">
                                    {Math.round(analysis.totalPrecip)} mm
                                </div>
                            </div>
                            <div className="text-center">
                                <div className="text-[11px] text-white/60 uppercase tracking-wider mb-0.5">Peak</div>
                                <div className="text-sm font-bold text-sky-400 tabular-nums">
                                    {Math.round(analysis.maxIntensity)} mm/hr
                                </div>
                            </div>
                            <div className="text-center">
                                <div className="text-[11px] text-white/60 uppercase tracking-wider mb-0.5">Type</div>
                                <div className="text-sm font-bold text-white">{analysis.category.label}</div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// --- Helpers ---

function getIntensityLabel(mmPerHr: number): string {
    if (mmPerHr >= 7.6) return 'Heavy Rain';
    if (mmPerHr >= 2.5) return 'Moderate Rain';
    if (mmPerHr >= 0.5) return 'Light Rain';
    if (mmPerHr > 0) return 'Drizzle';
    return 'Dry';
}

function getIntensityCategory(mmPerHr: number): { label: string; badgeClass: string; color: string } {
    if (mmPerHr >= 7.6)
        return {
            label: 'Heavy',
            badgeClass: 'bg-red-500/30 text-red-300 border border-red-400/30',
            color: 'rgba(239, 68, 68, 0.7)',
        };
    if (mmPerHr >= 2.5)
        return {
            label: 'Moderate',
            badgeClass: 'bg-amber-500/25 text-amber-300 border border-amber-400/25',
            color: 'rgba(245, 158, 11, 0.7)',
        };
    if (mmPerHr >= 0.5)
        return {
            label: 'Light',
            badgeClass: 'bg-sky-500/25 text-sky-300 border border-sky-400/25',
            color: 'rgba(59, 130, 246, 0.7)',
        };
    return {
        label: 'Drizzle',
        badgeClass: 'bg-sky-500/20 text-sky-300 border border-sky-400/20',
        color: 'rgba(14, 165, 233, 0.5)',
    };
}

function getBarColor(intensity: number, maxIntensity: number, active: boolean): string {
    if (intensity === 0) return 'transparent';

    const ratio = intensity / Math.max(maxIntensity, 0.1);

    if (active) {
        // Active: cyan → blue → indigo spectrum
        if (ratio > 0.8) return 'rgba(34, 211, 238, 0.95)'; // Cyan — peak
        if (ratio > 0.6) return 'rgba(56, 189, 248, 0.85)'; // Sky
        if (ratio > 0.4) return 'rgba(96, 165, 250, 0.80)'; // Blue
        if (ratio > 0.2) return 'rgba(129, 140, 248, 0.70)'; // Indigo
        return 'rgba(147, 197, 253, 0.55)'; // Light blue
    }

    // Quiet: muted blues
    if (ratio > 0.6) return 'rgba(96, 165, 250, 0.70)';
    if (ratio > 0.3) return 'rgba(96, 165, 250, 0.50)';
    return 'rgba(96, 165, 250, 0.35)';
}

export default RainForecastCard;
