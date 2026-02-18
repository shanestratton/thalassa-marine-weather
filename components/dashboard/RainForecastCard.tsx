import React, { useMemo } from 'react';

interface MinutelyRain {
    time: string;
    intensity: number; // mm/hr
}

interface RainForecastCardProps {
    data: MinutelyRain[];
    className?: string;
    timeZone?: string;
}

/**
 * RainForecastCard — Beautiful 60-bar precipitation chart
 * Replaces WIND/GUSTS/WAVE row when rain is expected in the next hour.
 */
export const RainForecastCard: React.FC<RainForecastCardProps> = ({ data, className = '', timeZone }) => {

    const analysis = useMemo(() => {
        if (!data || data.length === 0) return {
            maxIntensity: 0,
            hasRain: false,
            headline: 'No Rain Expected',
            subline: '',
            bars: [],
            isCurrentlyRaining: false,
            category: { label: '', badgeClass: '' },
        };

        const maxIntensity = Math.max(...data.map(d => d.intensity), 0.1); // Floor at 0.1 to avoid /0
        const hasRain = data.some(d => d.intensity > 0);

        // Find when rain starts / stops
        const firstRainIdx = data.findIndex(d => d.intensity > 0);
        const lastRainIdx = data.length - 1 - [...data].reverse().findIndex(d => d.intensity > 0);

        // Check if it's currently raining (minute 0)
        const isCurrentlyRaining = data[0]?.intensity > 0;

        // Find first dry minute (after rain starts)
        const firstDryAfterRain = isCurrentlyRaining
            ? data.findIndex((d, i) => i > 0 && d.intensity === 0)
            : -1;

        // Headline logic
        let headline = '';
        let subline = '';

        if (!hasRain) {
            headline = 'No Rain Expected';
            subline = 'Next 60 minutes';
        } else if (isCurrentlyRaining && firstDryAfterRain > 0) {
            headline = `Rain stopping in ${firstDryAfterRain} min`;
            subline = `${getIntensityLabel(data[0].intensity)}`;
        } else if (isCurrentlyRaining && firstDryAfterRain === -1) {
            headline = 'Rain for the next hour';
            subline = `${getIntensityLabel(maxIntensity)}`;
        } else if (firstRainIdx > 0) {
            headline = `Rain in ${firstRainIdx} min`;
            subline = `${getIntensityLabel(data[firstRainIdx].intensity)}`;
        }

        // Categorize intensity for the overall badge
        const category = getIntensityCategory(maxIntensity);

        return {
            maxIntensity,
            hasRain,
            firstRainIdx,
            lastRainIdx,
            isCurrentlyRaining,
            headline,
            subline,
            category
        };
    }, [data]);

    if (!analysis) return null;

    // Generate time labels for x-axis (every 15 min)
    const timeLabels = useMemo(() => {
        if (!data || data.length === 0) return [];
        const labels: { idx: number; label: string }[] = [];
        [0, 15, 30, 45, 60].forEach(min => {
            const idx = Math.min(min, data.length - 1);
            if (min === 0) {
                labels.push({ idx, label: 'Now' });
            } else {
                labels.push({ idx, label: `+${min}` });
            }
        });
        return labels;
    }, [data]);

    // Compact single-line card when no rain
    if (!analysis.hasRain) {
        return (
            <div className={`w-full rounded-xl overflow-hidden ${className}`}
                style={{
                    background: 'linear-gradient(135deg, rgba(30, 58, 138, 0.4), rgba(15, 23, 42, 0.5), rgba(30, 64, 175, 0.25))',
                    border: '1px solid rgba(96, 165, 250, 0.1)',
                }}
            >
                <div className="px-3 py-1.5 flex items-center gap-1.5">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" className="text-blue-400/60 shrink-0">
                        <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0L12 2.69z"
                            fill="currentColor" fillOpacity="0.3" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-300/60">
                        No Rain Expected
                    </span>
                </div>
            </div>
        );
    }

    return (
        <div className={`w-full rounded-xl overflow-hidden relative min-h-[52px] ${className}`}
            style={{
                background: 'linear-gradient(135deg, rgba(30, 58, 138, 0.5), rgba(15, 23, 42, 0.6), rgba(30, 64, 175, 0.3))',
                border: '1px solid rgba(96, 165, 250, 0.15)',
                boxShadow: '0 0 20px -5px rgba(59, 130, 246, 0.15), inset 0 1px 0 rgba(255,255,255,0.05)'
            }}
        >
            {/* Subtle animated rain glow */}
            {analysis.hasRain && (
                <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl">
                    <div className="absolute -top-10 left-1/4 w-20 h-20 bg-blue-500/10 rounded-full blur-2xl animate-pulse" />
                </div>
            )}

            <div className="relative z-10 px-3 py-1.5 h-full flex flex-col justify-between">
                {/* Header Row — compact single line */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-blue-400 shrink-0">
                            <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0L12 2.69z"
                                fill="currentColor" fillOpacity="0.3" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-300/90">
                            {analysis.headline}
                        </span>
                    </div>

                    {analysis.hasRain && (
                        <div className={`px-1.5 py-0 rounded-full text-[8px] font-bold uppercase tracking-wide leading-tight ${analysis.category.badgeClass}`}>
                            {analysis.category.label}
                        </div>
                    )}
                </div>

                {/* Bar Chart — compact */}
                <div className="flex items-end gap-[1px] h-[20px] w-full mt-1">
                    {data.map((point, i) => {
                        const normalizedHeight = analysis.maxIntensity > 0
                            ? Math.max((point.intensity / analysis.maxIntensity) * 100, point.intensity > 0 ? 10 : 0)
                            : 0;

                        const barColor = getBarColor(point.intensity, analysis.maxIntensity);

                        return (
                            <div key={i} className="flex-1 relative" style={{ height: '100%' }}>
                                <div
                                    className="absolute bottom-0 left-0 right-0 rounded-t-[1px]"
                                    style={{
                                        height: `${normalizedHeight}%`,
                                        background: barColor,
                                        minWidth: '1px',
                                        boxShadow: point.intensity > 0 ? `0 0 3px ${barColor}30` : 'none'
                                    }}
                                />
                            </div>
                        );
                    })}
                </div>


            </div>
        </div>
    );
};

// --- Helpers ---

function getIntensityLabel(mmPerHr: number): string {
    if (mmPerHr >= 7.6) return 'Heavy rain';
    if (mmPerHr >= 2.5) return 'Moderate rain';
    if (mmPerHr >= 0.5) return 'Light rain';
    if (mmPerHr > 0) return 'Drizzle';
    return 'Dry';
}

function getIntensityCategory(mmPerHr: number): { label: string; badgeClass: string } {
    if (mmPerHr >= 7.6) return {
        label: 'Heavy',
        badgeClass: 'bg-red-500/30 text-red-300 border border-red-400/30'
    };
    if (mmPerHr >= 2.5) return {
        label: 'Moderate',
        badgeClass: 'bg-amber-500/25 text-amber-300 border border-amber-400/25'
    };
    if (mmPerHr >= 0.5) return {
        label: 'Light',
        badgeClass: 'bg-blue-500/25 text-blue-300 border border-blue-400/25'
    };
    return {
        label: 'Drizzle',
        badgeClass: 'bg-sky-500/20 text-sky-300 border border-sky-400/20'
    };
}

function getBarColor(intensity: number, maxIntensity: number): string {
    if (intensity === 0) return 'transparent';

    const ratio = intensity / Math.max(maxIntensity, 0.1);

    // Gradient: cyan → blue → indigo → purple based on intensity
    if (ratio > 0.8) return 'rgba(129, 140, 248, 0.95)';  // Indigo — heavy
    if (ratio > 0.6) return 'rgba(99, 102, 241, 0.85)';   // Blue-indigo
    if (ratio > 0.4) return 'rgba(96, 165, 250, 0.80)';   // Blue
    if (ratio > 0.2) return 'rgba(56, 189, 248, 0.70)';   // Sky
    return 'rgba(103, 232, 249, 0.60)';                     // Cyan — light
}

export default RainForecastCard;
