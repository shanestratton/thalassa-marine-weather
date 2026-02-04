import React from 'react';
import { ArrowUpIcon, ArrowDownIcon } from '../../Icons';

// --- MOON LOGIC ---
export const getMoonPhaseData = (date: Date) => {
    const synodic = 29.53058867;
    const knownNewMoon = new Date('2000-01-06T12:24:01').getTime(); // UTC
    const diff = date.getTime() - knownNewMoon;
    const days = diff / (1000 * 60 * 60 * 24);

    // Normalize to 0-1 cycle
    let phaseRatio = (days % synodic) / synodic;
    if (phaseRatio < 0) phaseRatio += 1;

    let phaseName = '';
    // Approx phase windows
    if (phaseRatio < 0.03 || phaseRatio > 0.97) phaseName = 'New Moon';
    else if (phaseRatio < 0.22) phaseName = 'Waxing Crescent';
    else if (phaseRatio < 0.28) phaseName = 'First Quarter';
    else if (phaseRatio < 0.47) phaseName = 'Waxing Gibbous';
    else if (phaseRatio < 0.53) phaseName = 'Full Moon';
    else if (phaseRatio < 0.72) phaseName = 'Waning Gibbous';
    else if (phaseRatio < 0.78) phaseName = 'Last Quarter';
    else phaseName = 'Waning Crescent';

    // Illumination fraction (0 = New, 1 = Full)
    const illumination = 0.5 * (1 - Math.cos(phaseRatio * 2 * Math.PI));

    return { phaseName, illumination, phaseRatio };
};

interface MoonVisualProps {
    cloudCover: number;
    apiPhase?: string;
    apiIllumination?: number;
    apiPhaseValue?: number;
    lat?: number;
}

export const MoonVisual = ({ cloudCover, apiPhase, apiIllumination, apiPhaseValue, lat }: MoonVisualProps) => {
    // Local Calc Fallback
    const { phaseName: localName, illumination: localIllum, phaseRatio: localRatio } = getMoonPhaseData(new Date());

    const phaseName = apiPhase || localName;
    const illumination = apiIllumination !== undefined ? apiIllumination : localIllum;
    const phaseRatio = apiPhaseValue !== undefined ? apiPhaseValue : localRatio;

    // Southern Hemisphere Logic: Flip horizontal if lat is negative
    const isSouthernHemi = lat !== undefined && lat < 0;
    const flipStyle = isSouthernHemi ? { transform: 'scaleX(-1)', transformOrigin: 'center' } : {};

    // SVG Path Generation for Moon Phase
    const generateMoonPath = (phase: number) => {
        const r = 40;
        const cx = 50;
        const cy = 50;
        const theta = phase * 2 * Math.PI;

        const isWaxing = phase <= 0.5;
        const rawRx = r * Math.cos(theta);
        const rx = Math.abs(rawRx);

        let d = '';
        if (isWaxing) {
            const sweep = rawRx > 0 ? 1 : 0;
            d = `M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r} A ${rx} ${r} 0 0 ${sweep} ${cx} ${cy - r}`;
        } else {
            const sweep = rawRx < 0 ? 1 : 0;
            d = `M ${cx} ${cy + r} A ${r} ${r} 0 0 1 ${cx} ${cy - r} A ${rx} ${r} 0 0 ${sweep} ${cx} ${cy + r}`;
        }

        return d;
    };

    const safeCloud = cloudCover || 0;
    const cloudOpacity = Math.min(safeCloud / 100 * 0.85, 0.9);

    return (
        <div className="flex items-center gap-3">
            <div className="relative w-12 h-12 rounded-full bg-[#0f172a] border border-white/20 overflow-hidden shadow-inner">
                <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full">
                    <circle cx="50" cy="50" r="40" fill="#1e293b" />
                    <path
                        d={generateMoonPath(phaseRatio)}
                        fill="#e2e8f0"
                        className="transition-all duration-1000 ease-in-out"
                        style={flipStyle}
                    />
                </svg>
                {/* Simple Cloud Overlay */}
                <div
                    className="absolute inset-0 bg-slate-900 transition-all duration-1000 z-10 pointer-events-none mix-blend-overlay"
                    style={{ opacity: cloudOpacity }}
                ></div>
            </div>

            <div className="text-left leading-tight">
                <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-0.5">Lunar Phase</div>
                <div className="text-sm text-white font-bold tracking-wide whitespace-nowrap">{phaseName}</div>
                <div className="text-[10px] text-sky-400 font-mono">{(illumination * 100).toFixed(0)}% Illumination</div>
            </div>
        </div>
    );
};

interface SolarArcProps {
    sunrise: string;
    sunset: string;
    showTimes?: boolean;
    size?: 'normal' | 'large';
    timeZone?: string;
}

export const SolarArc = ({ sunrise, sunset, showTimes = true, size = 'normal', timeZone }: SolarArcProps) => {
    const parseTime = (tStr: string) => {
        if (!tStr || tStr === '--:--') return null;
        // Support 24h format (e.g. "14:30") or 12h (e.g. "2:30 PM")
        const parts = tStr.split(' ');
        let [time, period] = parts;
        let [h, m] = time.split(':').map(Number);
        if (isNaN(h) || isNaN(m)) return null;

        if (period) {
            if (period === 'PM' && h !== 12) h += 12;
            if (period === 'AM' && h === 12) h = 0;
        }
        return h * 60 + m;
    };

    const sr = parseTime(sunrise) || 360;
    const ss = parseTime(sunset) || 1080;

    // Get Current Time in Location's Timezone
    const getNowMins = () => {
        if (!timeZone) {
            const d = new Date();
            return d.getHours() * 60 + d.getMinutes();
        }
        try {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone,
                hour: 'numeric',
                minute: 'numeric',
                hour12: false
            }).formatToParts(new Date());
            const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
            const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
            return h * 60 + m;
        } catch (e) {
            const d = new Date();
            return d.getHours() * 60 + d.getMinutes();
        }
    };

    const current = getNowMins();

    const dayLength = ss - sr;
    const progress = Math.min(Math.max((current - sr) / dayLength, 0), 1);

    // Simplified Day Logic with Fallback for visual continuity
    const dayStarted = progress > 0;
    const dayEnded = progress < 1;
    const isDay = dayStarted && dayEnded;

    // Calculate position on arc (0 to 180 degrees)
    const angle = 180 - (progress * 180);
    const rad = (angle * Math.PI) / 180;

    // SVG coords
    const r = 40;
    const cx = 50;
    const cy = 50; // Bottom center of arc
    const x = cx + r * Math.cos(rad);
    const y = cy - r * Math.sin(rad);

    const heightClass = size === 'large' ? 'h-32' : 'h-12';

    return (
        <div className={`flex items-center gap-4 w-full ${size === 'large' ? 'flex-col justify-center' : ''}`}>
            {showTimes && size === 'normal' && (
                <div className="flex flex-col items-center">
                    <span className="text-[9px] text-gray-500 uppercase tracking-wider mb-1">Sunrise</span>
                    <span className="text-xs font-bold text-white flex items-center gap-1"><ArrowUpIcon className="w-3 h-3 text-orange-400" /> {sunrise}</span>
                </div>
            )}

            <div className={`flex-1 relative ${heightClass} flex justify-center items-end pb-1 w-full`}>
                <svg viewBox="0 0 100 50" className="w-full h-full overflow-visible">
                    {/* Horizon Line */}
                    <line x1="0" y1="50" x2="100" y2="50" stroke="rgba(255,255,255,0.1)" strokeWidth="1" strokeDasharray="3 3" />

                    {/* Arc Path */}
                    <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="2" strokeLinecap="round" />

                    {/* Celestial Body Indicator - Always Render */}
                    <circle
                        cx={x}
                        cy={y}
                        r={isDay ? "6" : "5"}
                        fill={isDay ? "#fbbf24" : "#94a3b8"}
                        stroke="rgba(255,255,255,0.5)"
                        strokeWidth="2"
                        className="transition-all duration-1000"
                    >
                        {isDay && <animate attributeName="r" values="6;7;6" dur="3s" repeatCount="indefinite" />}
                    </circle>

                    <defs>
                        <filter id="sunGlow" x="-50%" y="-50%" width="200%" height="200%">
                            <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                            <feMerge>
                                <feMergeNode in="coloredBlur" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                    </defs>
                </svg>
            </div>

            {showTimes && size === 'normal' && (
                <div className="flex flex-col items-center">
                    <span className="text-[9px] text-gray-500 uppercase tracking-wider mb-1">Sunset</span>
                    <span className="text-xs font-bold text-white flex items-center gap-1">{sunset} <ArrowDownIcon className="w-3 h-3 text-orange-400" /></span>
                </div>
            )}

            {size === 'large' && (
                <div className="flex justify-between w-full px-8 -mt-2">
                    <div className="flex flex-col items-start">
                        <span className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Sunrise</span>
                        <span className="text-xl font-bold text-white flex items-center gap-1"><ArrowUpIcon className="w-4 h-4 text-orange-400" /> {sunrise}</span>
                    </div>
                    <div className="flex flex-col items-end">
                        <span className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Sunset</span>
                        <span className="text-xl font-bold text-white flex items-center gap-1">{sunset} <ArrowDownIcon className="w-4 h-4 text-orange-400" /></span>
                    </div>
                </div>
            )}
        </div>
    );
};
