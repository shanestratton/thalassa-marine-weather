import React, { useMemo } from 'react';
import type { LatLon } from '../../services/dayPlanner/places';
import {
    pictureFrame,
    pictureLand,
    pictureNote,
    pictureXY,
    rosePath,
    roseWords,
    type PictureCoast,
} from '../../services/dayPlanner/stopPicture';
import { windSpan, type LegSummary } from '../../services/dayPlanner/today';

/**
 * The stop page's route picture and shelter rose (132-PYD-9), in their own
 * chunk: TodayStopDetail gives the picture its room and loads this only to
 * draw in it (services/dayPlanner/stopPicture.ts works it out). A small static
 * drawing, never a map instance per stop: land from OpenStreetMap, a dot at
 * her start, a pin at the stop, and the routed line once there is one, never
 * a straight line before; along its foot, what the land is and the wind on
 * the way out.
 */
export function StopMap({
    start,
    stop,
    route,
    coastline,
    wind,
}: {
    start: LatLon;
    stop: LatLon & { name: string };
    /** Routed on her charts, start to stop; null until then. */
    route: readonly LatLon[] | null;
    /** 'loading' while Plan Your Day is still asking for it; null when it did not load. */
    coastline: PictureCoast;
    /** The chosen leave's way out; null with no forecast. */
    wind: Pick<LegSummary, 'dirDeg' | 'loKts' | 'hiKts'> | null;
}) {
    const frame = useMemo(() => pictureFrame(start, route ? [stop, ...route] : [stop]), [start, stop, route]);
    const land = useMemo(() => pictureLand(frame, coastline), [frame, coastline]);
    const [sx, sy] = pictureXY(frame, start);
    const [px, py] = pictureXY(frame, stop);
    const span = wind && wind.dirDeg !== null ? windSpan(wind.dirDeg, wind.loKts, wind.hiKts) : '';
    const note = pictureNote(land);
    return (
        <>
            <svg
                viewBox="0 0 200 100"
                role="img"
                aria-label={`Map: your start (dot) and ${stop.name} (pin)${route ? ', the routed line' : ''}${span ? `, wind ${span} kn` : ''}. ${note.said}.`}
            >
                <rect className={land.kind === 'land' ? 'today-pic-sea' : 'today-pic-none'} width="200" height="100" />
                {land.kind === 'land' && <path className="today-pic-land" d={land.d} />}
                {land.kind === 'land' && land.edge && (
                    <path className="today-pic-none" d={land.edge} fillRule="evenodd" />
                )}
                {route && (
                    <polyline
                        className="today-pic-route"
                        points={route.map((p) => pictureXY(frame, p).join(',')).join(' ')}
                    />
                )}
                <circle className="today-pic-mark" cx={sx} cy={sy} r="3" />
                <path className="today-pic-mark" d={`M${px} ${py}l-3.4-5a4 4 0 1 1 6.8 0z`} />
            </svg>
            {/* One line: what the land is first; the wind's arrow, downwind, and its words where they fit. */}
            <p className="today-pic-band" aria-hidden="true">
                <span className="today-pic-note">{note.shown}</span>
                {span && (
                    <>
                        <svg
                            className="today-pic-wind"
                            viewBox="-6 -6 12 12"
                            style={{ transform: `rotate(${wind!.dirDeg! + 180}deg)` }}
                        >
                            <path d="M0 5V-5M-3.5-1.5 0-5l3.5 3.5" />
                        </svg>
                        <span>{span} kn</span>
                    </>
                )}
            </p>
        </>
    );
}

/** Beside the shelter word: which way the land shelters her, north up. */
export function ShelterRose({ table }: { table: readonly number[] }) {
    return (
        <svg viewBox="0 0 16 16" role="img" aria-label={roseWords(table)}>
            <circle cx="8" cy="8" r="7.4" />
            <path d={rosePath(table)} />
        </svg>
    );
}
