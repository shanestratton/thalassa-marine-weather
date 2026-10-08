/**
 * LiveMiniMap — the little map on the Log page's cards: the live recording
 * card (and its fullscreen view), and an expanded planned route.
 *
 * Since 125-13a it is Mapbox GL on Relief + Sat (components/LiveMiniMapGL.tsx,
 * on components/map/logMap.ts), loaded here with import() so the Log page's
 * own chunk does not carry it: mapbox-gl is the vendor chunk Obs already
 * loads. While that chunk arrives the card keeps its size and colour, so
 * nothing below it moves.
 *
 *   - Live Recording card: the active track with the boat's live dot
 *   - Planned Route card: the planned route in violet
 *   - Fullscreen (freeZoom): pans and pinches; a tap shrinks it
 */
import React, { Suspense, lazy, memo } from 'react';
import type { ShipLogEntry } from '../types';
import type { RouteCoordinate } from '../utils/routeCoordinates';

export interface LiveMiniMapProps {
    entries: ShipLogEntry[];
    /** Route currently being followed. Drawn independently beneath the GPS track. */
    followedRouteCoords?: readonly RouteCoordinate[];
    /**
     * Where the boat is RIGHT NOW, if known, for the map's very first viewport.
     * On a cold start the entries have not arrived yet (they come from the
     * network) and the followed route may be empty. The caller resolves it
     * synchronously from the live fix; the map uses it only when it has
     * nothing better, and never re-centres on it afterwards.
     */
    initialCenter?: { lat: number; lon: number } | null;
    height?: number | string; // px number or CSS string like '100%'
    isLive?: boolean; // Show the live boat dot at the latest position
    className?: string;
    /**
     * Fired on a tap on the map (never on its credits). Used to expand the
     * mini map to full screen and back.
     */
    onTap?: () => void;
    /**
     * Free-zoom mode (fullscreen). The card re-frames on the boat every poll
     * (isLive auto-follow), which is right when it's tiny. Fullscreen, that
     * would yank the skipper's pinch-zoom back, so the first touch here
     * RELEASES auto-follow and leaves their view put. The first frame still
     * takes in the track.
     */
    freeZoom?: boolean;
}

/**
 * The card's box with no map in it: its size, its corners, and (from
 * .thalassa-log-gl-map, with a daylight variant) the app's dark or light.
 */
export const miniMapBoxClass = (onTap: boolean, className: string) =>
    `thalassa-log-gl-map live-mini-map relative w-full rounded-2xl overflow-hidden border border-sky-400/15 shadow-xl shadow-black/30 ${onTap ? 'cursor-pointer' : ''} ${className}`;

const Placeholder: React.FC<LiveMiniMapProps> = ({ height = 160, onTap, className = '' }) => (
    <div className={miniMapBoxClass(!!onTap, className)} style={{ height }} />
);

// A chunk that cannot load (a dropped link mid-update) leaves the empty card,
// never an error over the whole Log page.
const LiveMiniMapGL = lazy(() => import('./LiveMiniMapGL').catch(() => ({ default: Placeholder })));

export const LiveMiniMap: React.FC<LiveMiniMapProps> = memo((props) => (
    <Suspense fallback={<Placeholder {...props} />}>
        <LiveMiniMapGL {...props} />
    </Suspense>
));

LiveMiniMap.displayName = 'LiveMiniMap';
