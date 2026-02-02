import React from 'react';
import { useWeather } from '../context/WeatherContext';
import { useSettings } from '../context/SettingsContext';
import { WindIcon, BoatIcon, ChevronLeftIcon } from './Icons';

interface CompassPageProps {
    onBack?: () => void;
}

export const CompassPage: React.FC<CompassPageProps> = ({ onBack }) => {
    const { weatherData } = useWeather();
    const { settings } = useSettings();

    // Get current wind data
    const windDirection = weatherData?.current?.windDegree ?? undefined;
    const windSpeed = weatherData?.current?.windSpeed ?? undefined;
    const windDirectionText = weatherData?.current?.windDirection;

    // Vessel heading
    const vesselHeading = 0;

    return (
        <div className="h-full w-full bg-gradient-to-br from-slate-800 via-slate-900 to-black overflow-y-auto relative">
            {/* Subtle background pattern */}
            <div
                className="absolute inset-0 opacity-5"
                style={{
                    backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 1px)',
                    backgroundSize: '40px 40px'
                }}
            />

            {/* Header */}
            <div className="sticky top-0 z-50 bg-slate-900/80 backdrop-blur-md border-b border-white/10 pt-[max(0.5rem,env(safe-area-inset-top))] pb-3 px-4">
                <div className="flex items-center justify-between">
                    {onBack && (
                        <button
                            onClick={onBack}
                            className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                        >
                            <ChevronLeftIcon className="w-6 h-6 text-white" />
                        </button>
                    )}
                    <div className="flex-1 text-center">
                        <h1 className="text-xl font-black text-white uppercase tracking-wider">
                            Navigation Compass
                        </h1>
                        <p className="text-xs text-gray-400 mt-1">
                            {weatherData?.locationName || 'Select a location'}
                        </p>
                    </div>
                    {onBack && <div className="w-10"></div>}
                </div>
            </div>

            {/* Main Content */}
            <div className="flex flex-col items-center justify-center p-6 min-h-[calc(100vh-6rem)] relative">

                {/* Large Heading Display */}
                {windDirection !== undefined && (
                    <div className="mb-8 text-center">
                        <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">Wind Direction</div>
                        <div className="text-7xl md:text-8xl font-black text-white tracking-tight">
                            {windDirection.toFixed(0)}°
                            <span className="text-4xl md:text-5xl ml-3 text-amber-400">
                                {windDirectionText || getCardinalDirection(windDirection)}
                            </span>
                        </div>
                    </div>
                )}

                {/* 3D Compass */}
                <div className="relative" style={{ width: '380px', height: '380px' }}>
                    <svg width="380" height="380" viewBox="0 0 380 380" className="drop-shadow-2xl">
                        <defs>
                            {/* Gold metallic gradient for rim */}
                            <radialGradient id="goldRim" cx="50%" cy="30%">
                                <stop offset="0%" stopColor="#ffd700" />
                                <stop offset="40%" stopColor="#daa520" />
                                <stop offset="70%" stopColor="#b8860b" />
                                <stop offset="100%" stopColor="#8b6508" />
                            </radialGradient>

                            {/* Inner rim shadow */}
                            <radialGradient id="innerShadow" cx="50%" cy="50%">
                                <stop offset="70%" stopColor="#1a1a1a" />
                                <stop offset="100%" stopColor="#000000" />
                            </radialGradient>

                            {/* Compass face gradient */}
                            <radialGradient id="compassFace" cx="50%" cy="50%">
                                <stop offset="0%" stopColor="#2a2a2a" />
                                <stop offset="100%" stopColor="#0f0f0f" />
                            </radialGradient>

                            {/* Center medallion */}
                            <radialGradient id="centerGold" cx="50%" cy="30%">
                                <stop offset="0%" stopColor="#ffd700" />
                                <stop offset="50%" stopColor="#daa520" />
                                <stop offset="100%" stopColor="#b8860b" />
                            </radialGradient>

                            {/* Red needle gradient */}
                            <linearGradient id="redNeedle" x1="0%" y1="0%" x2="0%" y2="100%">
                                <stop offset="0%" stopColor="#ff4444" />
                                <stop offset="50%" stopColor="#cc0000" />
                                <stop offset="100%" stopColor="#880000" />
                            </linearGradient>

                            {/* Gold needle gradient */}
                            <linearGradient id="goldNeedle" x1="0%" y1="0%" x2="0%" y2="100%">
                                <stop offset="0%" stopColor="#ffd700" />
                                <stop offset="50%" stopColor="#daa520" />
                                <stop offset="100%" stopColor="#b8860b" />
                            </linearGradient>

                            {/* 3D effect filters */}
                            <filter id="emboss">
                                <feGaussianBlur in="SourceAlpha" stdDeviation="2" />
                                <feOffset dx="1" dy="2" result="offsetblur" />
                                <feComponentTransfer>
                                    <feFuncA type="linear" slope="0.5" />
                                </feComponentTransfer>
                                <feMerge>
                                    <feMergeNode />
                                    <feMergeNode in="SourceGraphic" />
                                </feMerge>
                            </filter>

                            <filter id="glow">
                                <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                                <feMerge>
                                    <feMergeNode in="coloredBlur" />
                                    <feMergeNode in="SourceGraphic" />
                                </feMerge>
                            </filter>
                        </defs>

                        {/* Outer Gold Rim */}
                        <circle cx="190" cy="190" r="185" fill="url(#goldRim)" filter="url(#emboss)" />
                        <circle cx="190" cy="190" r="183" fill="none" stroke="#000" strokeWidth="0.5" opacity="0.3" />

                        {/* Inner rim ridge */}
                        <circle cx="190" cy="190" r="170" fill="none" stroke="url(#goldRim)" strokeWidth="6" />
                        <circle cx="190" cy="190" r="167" fill="none" stroke="#8b6508" strokeWidth="1" />

                        {/* Compass Face */}
                        <circle cx="190" cy="190" r="160" fill="url(#compassFace)" />

                        {/* Radial gold lines from center */}
                        {Array.from({ length: 48 }, (_, i) => {
                            const angle = (i * 7.5 - 90) * (Math.PI / 180);
                            const x1 = 190 + 30 * Math.cos(angle);
                            const y1 = 190 + 30 * Math.sin(angle);
                            const x2 = 190 + 155 * Math.cos(angle);
                            const y2 = 190 + 155 * Math.sin(angle);
                            return (
                                <line
                                    key={i}
                                    x1={x1}
                                    y1={y1}
                                    x2={x2}
                                    y2={y2}
                                    stroke="#daa520"
                                    strokeWidth="0.5"
                                    opacity="0.15"
                                />
                            );
                        })}

                        {/* Degree markers */}
                        {Array.from({ length: 72 }, (_, i) => {
                            const degree = i * 5;
                            const isCardinal = degree % 90 === 0;
                            const isMajor = degree % 30 === 0;
                            const angle = (degree - 90) * (Math.PI / 180);
                            const innerR = isCardinal ? 135 : isMajor ? 140 : 145;
                            const outerR = 156;

                            return (
                                <line
                                    key={degree}
                                    x1={190 + innerR * Math.cos(angle)}
                                    y1={190 + innerR * Math.sin(angle)}
                                    x2={190 + outerR * Math.cos(angle)}
                                    y2={190 + outerR * Math.sin(angle)}
                                    stroke={isCardinal ? "#daa520" : "#8b7355"}
                                    strokeWidth={isCardinal ? 2.5 : isMajor ? 1.5 : 0.8}
                                    strokeLinecap="round"
                                />
                            );
                        })}

                        {/* Cardinal directions */}
                        {[
                            { label: 'N', deg: 0 },
                            { label: 'E', deg: 90 },
                            { label: 'S', deg: 180 },
                            { label: 'W', deg: 270 },
                        ].map(({ label, deg }) => {
                            const angle = (deg - 90) * (Math.PI / 180);
                            const x = 190 + 120 * Math.cos(angle);
                            const y = 190 + 120 * Math.sin(angle);
                            return (
                                <text
                                    key={label}
                                    x={x}
                                    y={y}
                                    textAnchor="middle"
                                    dominantBaseline="middle"
                                    className="text-3xl font-black"
                                    fill="url(#goldRim)"
                                    filter="url(#glow)"
                                >
                                    {label}
                                </text>
                            );
                        })}

                        {/* Intercardinal directions */}
                        {[
                            { label: 'NE', deg: 45 },
                            { label: 'SE', deg: 135 },
                            { label: 'SW', deg: 225 },
                            { label: 'NW', deg: 315 },
                        ].map(({ label, deg }) => {
                            const angle = (deg - 90) * (Math.PI / 180);
                            const x = 190 + 120 * Math.cos(angle);
                            const y = 190 + 120 * Math.sin(angle);
                            return (
                                <text
                                    key={label}
                                    x={x}
                                    y={y}
                                    textAnchor="middle"
                                    dominantBaseline="middle"
                                    className="text-lg font-bold"
                                    fill="#daa520"
                                >
                                    {label}
                                </text>
                            );
                        })}

                        {/* Degree numbers */}
                        {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg) => {
                            const angle = (deg - 90) * (Math.PI / 180);
                            const x = 190 + 100 * Math.cos(angle);
                            const y = 190 + 100 * Math.sin(angle);
                            return (
                                <text
                                    key={deg}
                                    x={x}
                                    y={y}
                                    textAnchor="middle"
                                    dominantBaseline="middle"
                                    className="text-xs font-mono font-bold"
                                    fill="#8b7355"
                                >
                                    {deg}
                                </text>
                            );
                        })}

                        {/* Wind direction needle */}
                        {windDirection !== undefined && (
                            <g transform={`rotate(${windDirection} 190 190)`}>
                                {/* North-pointing needle (red) */}
                                <path
                                    d="M 190 55 L 195 185 L 190 180 L 185 185 Z"
                                    fill="url(#redNeedle)"
                                    stroke="#000"
                                    strokeWidth="1"
                                    filter="url(#emboss)"
                                />
                                {/* South-pointing needle (gold) */}
                                <path
                                    d="M 190 325 L 195 195 L 190 200 L 185 195 Z"
                                    fill="url(#goldNeedle)"
                                    stroke="#000"
                                    strokeWidth="1"
                                    filter="url(#emboss)"
                                />
                            </g>
                        )}

                        {/* Center medallion */}
                        <circle cx="190" cy="190" r="22" fill="url(#centerGold)" filter="url(#emboss)" />
                        <circle cx="190" cy="190" r="18" fill="#1a1a1a" />
                        <circle cx="190" cy="190" r="14" fill="url(#centerGold)" />
                        <circle cx="190" cy="190" r="6" fill="#000" />

                        {/* Center star */}
                        {Array.from({ length: 8 }, (_, i) => {
                            const angle = (i * 45 - 90) * (Math.PI / 180);
                            const x = 190 + 10 * Math.cos(angle);
                            const y = 190 + 10 * Math.sin(angle);
                            return (
                                <line
                                    key={i}
                                    x1="190"
                                    y1="190"
                                    x2={x}
                                    y2={y}
                                    stroke="#daa520"
                                    strokeWidth="1"
                                />
                            );
                        })}
                    </svg>
                </div>

                {/* Wind Info Cards */}
                {windSpeed !== undefined && (
                    <div className="mt-12 flex gap-4">
                        <div className="bg-black/60 backdrop-blur-md border border-amber-500/30 rounded-2xl px-6 py-4 min-w-[140px]">
                            <div className="flex items-center gap-2 mb-1">
                                <WindIcon className="w-4 h-4 text-amber-400" />
                                <div className="text-xs text-gray-400 uppercase tracking-wide">Speed</div>
                            </div>
                            <div className="text-3xl font-black text-white">
                                {windSpeed.toFixed(1)}
                                <span className="text-sm text-gray-400 ml-1">kts</span>
                            </div>
                        </div>

                        {weatherData?.current?.windGust && (
                            <div className="bg-black/60 backdrop-blur-md border border-red-500/30 rounded-2xl px-6 py-4 min-w-[140px]">
                                <div className="flex items-center gap-2 mb-1">
                                    <WindIcon className="w-4 h-4 text-red-400" />
                                    <div className="text-xs text-gray-400 uppercase tracking-wide">Gust</div>
                                </div>
                                <div className="text-3xl font-black text-white">
                                    {weatherData.current.windGust.toFixed(1)}
                                    <span className="text-sm text-gray-400 ml-1">kts</span>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

// Helper to convert degrees to cardinal direction
function getCardinalDirection(degrees: number): string {
    const normalized = ((degrees % 360) + 360) % 360;

    if (normalized >= 348.75 || normalized < 11.25) return 'N';
    if (normalized >= 11.25 && normalized < 33.75) return 'NNE';
    if (normalized >= 33.75 && normalized < 56.25) return 'NE';
    if (normalized >= 56.25 && normalized < 78.75) return 'ENE';
    if (normalized >= 78.75 && normalized < 101.25) return 'E';
    if (normalized >= 101.25 && normalized < 123.75) return 'ESE';
    if (normalized >= 123.75 && normalized < 146.25) return 'SE';
    if (normalized >= 146.25 && normalized < 168.75) return 'SSE';
    if (normalized >= 168.75 && normalized < 191.25) return 'S';
    if (normalized >= 191.25 && normalized < 213.75) return 'SSW';
    if (normalized >= 213.75 && normalized < 236.25) return 'SW';
    if (normalized >= 236.25 && normalized < 258.75) return 'WSW';
    if (normalized >= 258.75 && normalized < 281.25) return 'W';
    if (normalized >= 281.25 && normalized < 303.75) return 'WNW';
    if (normalized >= 303.75 && normalized < 326.25) return 'NW';
    return 'NNW';
}
