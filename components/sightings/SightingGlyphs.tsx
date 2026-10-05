/**
 * Stroke glyphs for the eight sighting groups and the few controls Sightings
 * draws. No images of animals anywhere (no licences to track): each group is
 * a simple line drawing in the current colour.
 */
import React from 'react';
import type { SightingGroup } from '../../services/sightings/types';

const WAVE = 'M3 20.5c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1';

const GROUP_PATHS: Record<SightingGroup, React.ReactNode> = {
    whale: (
        <>
            <path d="M12 13.5C10.2 9.6 6.4 8.4 3 9.4c1 3.4 5 5.2 9 4.1z" />
            <path d="M12 13.5c1.8-3.9 5.6-5.1 9-4.1-1 3.4-5 5.2-9 4.1z" />
            <path d="M12 13.5V18" />
            <path d={WAVE} />
        </>
    ),
    dolphin: (
        <>
            <path d="M3 15.5c2.5-5.5 8-8.5 13.5-7.5l2.5-2.5-.6 3.6c1.6.9 2.6 2 3.1 3.4-1.6-.4-3-.4-4.3.2" />
            <path d="M10.3 9.3l.9-3.3 2.6 2.3" />
            <path d="M8.5 12.2c-1.2 1.2-1.9 2.4-2.1 3.6" />
            <path d={WAVE} />
        </>
    ),
    dugong: (
        <>
            <path d="M4 13c0-2.8 3.4-4.5 8-4.5 3.4 0 5.4 1.2 6.4 3l2.6-2v6l-2.6-2c-1 1.8-3 3-6.4 3C7.4 16.5 4 15.6 4 13z" />
            <path d="M7 15.8l-.8 2.2M11 16.4l.6 2" />
            <circle cx="6.8" cy="12" r=".6" fill="currentColor" />
            <path d="M4.2 13.6h1.4" />
        </>
    ),
    turtle: (
        <>
            <ellipse cx="12" cy="12.5" rx="5.2" ry="6" />
            <path d="M12 6.5V4.2" />
            <circle cx="12" cy="3.4" r="1.2" />
            <path d="M7.2 9.5L4 8M16.8 9.5L20 8M7.5 16.3l-2.6 2.2M16.5 16.3l2.6 2.2M12 18.5v2" />
            <path d="M9.3 10.5h5.4l1 2.6-1 2.6H9.3l-1-2.6z" />
        </>
    ),
    seabird: (
        <>
            <path d="M2 10.5c3.2-.3 6.2 1.5 10 5.2 3.8-3.7 6.8-5.5 10-5.2" />
            <path d="M12 15.7l-.9-1.9M12 15.7l.9-1.9" />
            <path d="M4 19.5c1.3 0 1.3-.8 2.6-.8" />
        </>
    ),
    shark_ray: (
        <>
            <path d="M5 17c2.2-1.4 4.6-6.4 8.5-11.5.2 4.8 1.2 8.9 3.5 11.5" />
            <path d={WAVE} />
        </>
    ),
    fish: (
        <>
            <path d="M3 12c2.8-4.2 8.6-5.4 13-.2-4.4 5.2-10.2 4.2-13 .2z" />
            <path d="M16 11.8l5-3.8v8z" />
            <circle cx="7.6" cy="11.3" r=".7" fill="currentColor" />
            <path d="M11 9.5c.6 1.5.6 3.3 0 5" />
        </>
    ),
    other: (
        <>
            <path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z" />
            <path d="M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z" />
        </>
    ),
};

const ICON_PATHS = {
    close: <path d="M6 6l12 12M18 6L6 18" />,
    check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
    lock: (
        <>
            <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
            <path d="M8 10.5V8a4 4 0 018 0v2.5" />
        </>
    ),
    crew: (
        <>
            <path d="M16 19v-1.5a3.5 3.5 0 00-3.5-3.5h-5A3.5 3.5 0 004 17.5V19" />
            <circle cx="10" cy="8" r="3.2" />
            <path d="M20 19v-1.4a3.2 3.2 0 00-2.4-3.1M15.8 5a3.2 3.2 0 010 6.2" />
        </>
    ),
    globe: (
        <>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5S9.6 5.9 12 3.5z" />
        </>
    ),
    me: (
        <>
            <circle cx="12" cy="8" r="3.4" />
            <path d="M5 20c.6-3.6 3.4-6 7-6s6.4 2.4 7 6" />
        </>
    ),
    camera: (
        <>
            <path d="M4 8.5h3l1.6-2.2h6.8L17 8.5h3v10H4z" />
            <circle cx="12" cy="13.4" r="3.4" />
        </>
    ),
    search: (
        <>
            <circle cx="11" cy="11" r="6.5" />
            <path d="M20 20l-4.3-4.3" />
        </>
    ),
    pin: (
        <>
            <path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0113 0c0 4.8-6.5 11-6.5 11z" />
            <circle cx="12" cy="10" r="2.3" />
        </>
    ),
    cloudOff: (
        <>
            <path d="M3 3l18 18" />
            <path d="M8.5 7.4A5.5 5.5 0 0117.4 11 4 4 0 0119 18.4M15.5 19H7a4 4 0 01-1.2-7.8" />
        </>
    ),
    alert: (
        <>
            <path d="M12 4l9 16H3z" />
            <path d="M12 10v4M12 17.2v.3" />
        </>
    ),
};
export type SightingIconName = keyof typeof ICON_PATHS;

const strokeProps = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
};

export const GroupGlyph: React.FC<{ group: SightingGroup; className?: string }> = ({
    group,
    className = 'h-6 w-6',
}) => (
    <svg aria-hidden="true" className={className} {...strokeProps}>
        {GROUP_PATHS[group] ?? GROUP_PATHS.other}
    </svg>
);

export const SightingIcon: React.FC<{ name: SightingIconName; className?: string }> = ({
    name,
    className = 'h-4 w-4',
}) => (
    <svg aria-hidden="true" className={className} {...strokeProps}>
        {ICON_PATHS[name]}
    </svg>
);

/** A group glyph in the hub's sky chip. */
export const GroupChip: React.FC<{ group: SightingGroup; size?: 'sm' | 'md' | 'lg' }> = ({ group, size = 'md' }) => {
    const box =
        size === 'lg'
            ? 'h-[48px] w-[48px] rounded-[14px]'
            : size === 'sm'
              ? 'h-9 w-9 rounded-[10px]'
              : 'h-10 w-10 rounded-xl';
    const glyph = size === 'lg' ? 'h-[26px] w-[26px]' : size === 'sm' ? 'h-[18px] w-[18px]' : 'h-5 w-5';
    return (
        <span aria-hidden="true" className={`sg-chip flex shrink-0 items-center justify-center ${box}`}>
            <GroupGlyph group={group} className={glyph} />
        </span>
    );
};
