/**
 * ChartSourceIcons — SVG icons for chart-source list rows.
 *
 * Replaces flag emojis which render inconsistently on iOS WKWebView (often
 * showing as small greyscale glyphs or falling back to Apple Color Emoji at
 * sizes that look out of place in the dense chart-picker list).
 *
 * Each icon is:
 *   - Stroke-drawn, 24×24 viewBox, single-color via currentColor
 *   - Visually distinct at a glance (anchor / flag / seal / folder)
 *   - Paired with the section accent color for the source's region
 */
import React from 'react';

interface IconProps {
    className?: string;
}

/** Nautical chart grid with folded corner — generic chart icon. */
export const ChartIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m0 0l-3.75 2.25V9L9 6.75z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75l6 2.25m0 8.25l3.75-2.25V6.75L15 9v8.25z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 15l6 2.25" />
    </svg>
);

/** Anchor — AvNav / o-charts (boat-side nautical chart servers). */
export const AnchorIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <circle cx={12} cy={5} r={1.5} strokeLinecap="round" strokeLinejoin="round" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.5v14M8.5 10h7" />
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5 14.5c0 3.5 3 6 7 6s7-2.5 7-6M5 14.5l-1.5 1.5M5 14.5h2m12 0l1.5 1.5M19 14.5h-2"
        />
    </svg>
);

/** US-style stars — NOAA (US waters charts). */
export const NoaaIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <circle cx={12} cy={12} r={8.5} strokeLinecap="round" strokeLinejoin="round" />
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 7.5l1.18 2.39 2.64.38-1.91 1.86.45 2.63L12 13.52l-2.36 1.24.45-2.63-1.91-1.86 2.64-.38L12 7.5z"
            fill="currentColor"
            fillOpacity={0.15}
        />
    </svg>
);

/** Grid / electronic chart — for ECDIS-style symbology. */
export const EcdisIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <rect x={3.5} y={3.5} width={17} height={17} rx={2} strokeLinecap="round" strokeLinejoin="round" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 9h17M3.5 15h17M9 3.5v17M15 3.5v17" />
    </svg>
);

/** Fern-ish LINZ icon — NZ hydrographic charts. Silver-fern silhouette. */
export const LinzIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18" />
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6c-1.5 1-3 1.5-4.5 1.5M12 6c1.5 1 3 1.5 4.5 1.5M12 10c-2 1.3-4 1.8-6 1.8M12 10c2 1.3 4 1.8 6 1.8M12 14.5c-2 1.3-4 1.8-5.5 1.8M12 14.5c2 1.3 4 1.8 5.5 1.8"
        />
    </svg>
);

/** Folder with grid — Local MBTiles charts on device. */
export const LocalChartIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 8.25V6A1.5 1.5 0 015.25 4.5h4.19a1.5 1.5 0 011.06.44l1.56 1.56h6.69A1.5 1.5 0 0120.25 8v9.75A1.5 1.5 0 0118.75 19.25H5.25a1.5 1.5 0 01-1.5-1.5v-9.5z"
        />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6M12 10v6" />
    </svg>
);

/**
 * Dispatch a chart icon based on a chart-source ID.
 * Returns the ChartIcon fallback for unknown IDs.
 */
export function iconForChartSource(sourceId: string): React.FC<IconProps> {
    switch (sourceId) {
        case 'noaa-ncds':
            return NoaaIcon;
        case 'noaa-ecdis':
            return EcdisIcon;
        case 'linz-charts':
            return LinzIcon;
        case 'openseamap':
            return AnchorIcon;
        default:
            return ChartIcon;
    }
}
