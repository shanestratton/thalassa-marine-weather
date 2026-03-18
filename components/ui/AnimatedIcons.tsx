/**
 * AnimatedIcons — Weather icons with CSS micro-animations on mount.
 *
 * Each icon uses CSS keyframes for subtle motion:
 *   - Wind: blades oscillate
 *   - Rain: drops cascade down
 *   - Sun: rays pulse/rotate
 *   - Wave: undulates
 *   - Cloud: gentle drift
 *   - Compass: needle wobble on mount
 *
 * All animations are triggered via CSS classes with animation-fill-mode: both
 * so they play once on mount and settle.
 */
import React, { useRef } from 'react';

// ── All keyframes moved to index.css to prevent CSSOM thrashing ──
// Classes: .anim-icon, .anim-wind, .anim-rain-1/2/3, .anim-sun-core,
//          .anim-sun-rays, .anim-wave, .anim-cloud, .anim-compass

interface AnimatedIconProps {
    className?: string;
}

// ═══════════════════════════════════════════
// ANIMATED WIND ICON
// ═══════════════════════════════════════════
export const AnimatedWindIcon: React.FC<AnimatedIconProps> = ({ className = 'w-5 h-5' }) => (
    <svg
        className={`${className} anim-icon`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        <g className="anim-wind">
            <path d="M17.7 7.7A2.5 2.5 0 0 1 17 12H3" />
            <path d="M9.6 4.6A2 2 0 0 1 11 8H3" />
            <path d="M12.6 19.4A2 2 0 0 0 14 16H3" />
        </g>
    </svg>
);

// ═══════════════════════════════════════════
// ANIMATED RAIN ICON
// ═══════════════════════════════════════════
export const AnimatedRainIcon: React.FC<AnimatedIconProps> = ({ className = 'w-5 h-5' }) => (
    <svg
        className={`${className} anim-icon`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
    >
        {/* Cloud */}
        <g className="anim-cloud">
            <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
        </g>
        {/* Rain drops */}
        <line x1="8" y1="15" x2="8" y2="19" className="anim-rain-1" />
        <line x1="12" y1="15" x2="12" y2="19" className="anim-rain-2" />
        <line x1="16" y1="15" x2="16" y2="19" className="anim-rain-3" />
    </svg>
);

// ═══════════════════════════════════════════
// ANIMATED SUN ICON
// ═══════════════════════════════════════════
export const AnimatedSunIcon: React.FC<AnimatedIconProps> = ({ className = 'w-5 h-5' }) => (
    <svg
        className={`${className} anim-icon`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
    >
        {/* Core */}
        <circle cx="12" cy="12" r="4" className="anim-sun-core" />
        {/* Rays */}
        <g className="anim-sun-rays">
            <line x1="12" y1="2" x2="12" y2="4" />
            <line x1="12" y1="20" x2="12" y2="22" />
            <line x1="4.93" y1="4.93" x2="6.34" y2="6.34" />
            <line x1="17.66" y1="17.66" x2="19.07" y2="19.07" />
            <line x1="2" y1="12" x2="4" y2="12" />
            <line x1="20" y1="12" x2="22" y2="12" />
            <line x1="4.93" y1="19.07" x2="6.34" y2="17.66" />
            <line x1="17.66" y1="6.34" x2="19.07" y2="4.93" />
        </g>
    </svg>
);

// ═══════════════════════════════════════════
// ANIMATED WAVE ICON
// ═══════════════════════════════════════════
export const AnimatedWaveIcon: React.FC<AnimatedIconProps> = ({ className = 'w-5 h-5' }) => (
    <svg
        className={`${className} anim-icon`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
    >
        <g className="anim-wave">
            <path d="M2 12c1.5-2 3.5-2 5 0s3.5 2 5 0 3.5-2 5 0 3.5 2 5 0" />
        </g>
        <g className="anim-wave" style={{ animationDelay: '0.4s' }}>
            <path d="M2 17c1.5-2 3.5-2 5 0s3.5 2 5 0 3.5-2 5 0 3.5 2 5 0" opacity="0.5" />
        </g>
        <g className="anim-wave" style={{ animationDelay: '0.8s' }}>
            <path d="M2 7c1.5-2 3.5-2 5 0s3.5 2 5 0 3.5-2 5 0 3.5 2 5 0" opacity="0.3" />
        </g>
    </svg>
);

// ═══════════════════════════════════════════
// ANIMATED CLOUD ICON
// ═══════════════════════════════════════════
export const AnimatedCloudIcon: React.FC<AnimatedIconProps> = ({ className = 'w-5 h-5' }) => (
    <svg
        className={`${className} anim-icon`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
    >
        <g className="anim-cloud">
            <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z" />
        </g>
    </svg>
);

// ═══════════════════════════════════════════
// ANIMATED COMPASS ICON (wobble on mount)
// ═══════════════════════════════════════════
export const AnimatedCompassIcon: React.FC<AnimatedIconProps> = ({ className = 'w-5 h-5' }) => (
    <svg
        className={`${className} anim-icon`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
    >
        <circle cx="12" cy="12" r="10" />
        <g className="anim-compass">
            <polygon
                points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88"
                fill="currentColor"
                fillOpacity="0.3"
                stroke="currentColor"
                strokeWidth="1"
            />
        </g>
    </svg>
);

// ═══════════════════════════════════════════
// ANIMATED THERMOMETER ICON
// ═══════════════════════════════════════════
export const AnimatedThermometerIcon: React.FC<AnimatedIconProps> = ({ className = 'w-5 h-5' }) => (
    <svg
        className={`${className} anim-icon`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
    >
        <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />
        <circle cx="11.5" cy="17.5" r="1.5" className="anim-sun-core" fill="currentColor" fillOpacity="0.4" />
    </svg>
);
