/**
 * FitzRoy Storm Glass nav icon — teardrop-shaped glass bottle with stylised
 * crystals inside. Sized and toned to match the existing cyan neon nav icons
 * (NAV_ICON_MAP, NAV_ICON_CHAT, NAV_ICON_VESSEL) so it sits flush in the
 * bottom navigation without standing out.
 */
import React from 'react';

interface StormGlassNavIconProps {
    className?: string;
    style?: React.CSSProperties;
}

export const StormGlassNavIcon: React.FC<StormGlassNavIconProps> = ({ className, style }) => (
    <svg
        viewBox="0 0 128 128"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        style={style}
        aria-hidden="true"
    >
        <defs>
            {/* Soft cyan halo to match the diffused glow on the other PNG icons */}
            <filter id="sg-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="1.8" result="blur" />
                <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                </feMerge>
            </filter>
            {/* Faint internal liquid tint */}
            <linearGradient id="sg-liquid" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#5fe5f0" stopOpacity="0.05" />
                <stop offset="60%" stopColor="#5fe5f0" stopOpacity="0.18" />
                <stop offset="100%" stopColor="#5fe5f0" stopOpacity="0.28" />
            </linearGradient>
        </defs>

        {/* ── Cork / cap ───────────────────────────────────────────── */}
        <rect x="56" y="14" width="16" height="7" rx="1.5" fill="#5fe5f0" opacity="0.85" filter="url(#sg-glow)" />
        <line x1="58" y1="21" x2="70" y2="21" stroke="#5fe5f0" strokeWidth="1.2" opacity="0.5" />

        {/* ── Bottle neck ──────────────────────────────────────────── */}
        <path
            d="M 60 22 L 60 34 L 58 38 L 70 38 L 68 34 L 68 22 Z"
            fill="none"
            stroke="#5fe5f0"
            strokeWidth="2.2"
            strokeLinejoin="round"
            filter="url(#sg-glow)"
        />

        {/* ── Teardrop bottle body ─────────────────────────────────── */}
        <path
            d="M 58 38
               Q 44 52 40 78
               Q 38 102 64 112
               Q 90 102 88 78
               Q 84 52 70 38 Z"
            fill="url(#sg-liquid)"
            stroke="#5fe5f0"
            strokeWidth="2.4"
            strokeLinejoin="round"
            filter="url(#sg-glow)"
        />

        {/* ── Liquid surface (gentle meniscus) ─────────────────────── */}
        <path
            d="M 47 60 Q 52 57 57 60 T 67 60 T 77 60 T 84 60"
            fill="none"
            stroke="#5fe5f0"
            strokeWidth="1.6"
            strokeLinecap="round"
            opacity="0.7"
        />

        {/* ── Crystals / shards inside the bottle ──────────────────── */}
        {/* Tall central spire */}
        <path d="M 60 96 L 64 70 L 68 96 L 64 102 Z" fill="#5fe5f0" opacity="0.85" filter="url(#sg-glow)" />
        {/* Right-side shard */}
        <path d="M 72 102 L 78 82 L 82 100 L 76 106 Z" fill="#5fe5f0" opacity="0.65" />
        {/* Left-side shard */}
        <path d="M 46 100 L 52 84 L 56 100 L 50 105 Z" fill="#5fe5f0" opacity="0.55" />
        {/* Small floating fleck near surface */}
        <path d="M 70 70 L 73 65 L 76 70 L 73 73 Z" fill="#5fe5f0" opacity="0.5" />

        {/* ── Glass highlight ──────────────────────────────────────── */}
        <path
            d="M 50 50 Q 46 70 50 92"
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.4"
            strokeLinecap="round"
            opacity="0.35"
        />
    </svg>
);
