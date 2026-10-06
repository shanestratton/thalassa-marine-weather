/**
 * crewGlyphs — the line glyphs the Crew & Float Plan page draws in its one
 * accent (Shane 2026-10-06: "the crew and float plan page also needs to be
 * dragged into the 21st century as well").
 *
 * The register chips used to lead with emoji, ten colours in one card; these
 * are one stroke weight, one size and one colour (currentColor), so a chip row
 * reads as one grid. Kept here, not in components/Icons, so the page's tests
 * that mock that barrel keep their short lists.
 */
import React from 'react';
import type { SharedRegister } from '../../services/CrewService';

interface GlyphProps {
    className?: string;
}

const Glyph: React.FC<GlyphProps & { d: string[]; circles?: Array<[number, number, number]> }> = ({
    className = 'h-4 w-4',
    d,
    circles = [],
}) => (
    <svg
        aria-hidden="true"
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        {circles.map(([cx, cy, r]) => (
            <circle key={`${cx}-${cy}-${r}`} cx={cx} cy={cy} r={r} />
        ))}
        {d.map((path) => (
            <path key={path} d={path} />
        ))}
    </svg>
);

const REGISTER_PATHS: Record<SharedRegister, { d: string[]; circles?: Array<[number, number, number]> }> = {
    // A crate.
    stores: {
        d: [
            'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z',
            'M3.3 7 12 12l8.7-5',
            'M12 22V12',
        ],
    },
    // A cog.
    equipment: {
        d: [
            'M12 2v3',
            'M12 19v3',
            'M4.93 4.93l2.12 2.12',
            'M16.95 16.95l2.12 2.12',
            'M2 12h3',
            'M19 12h3',
            'M4.93 19.07l2.12-2.12',
            'M16.95 7.05l2.12-2.12',
        ],
        circles: [
            [12, 12, 7],
            [12, 12, 2.5],
        ],
    },
    // A spanner.
    maintenance: {
        d: [
            'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
        ],
    },
    // A page of text.
    documents: {
        d: [
            'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
            'M14 2v4a2 2 0 0 0 2 2h4',
            'M16 13H8',
            'M16 17H8',
            'M10 9H8',
        ],
    },
    // A chef's hat.
    galley: {
        d: [
            'M17 21a1 1 0 0 0 1-1v-5.35c0-.46.32-.84.73-1.04a4 4 0 0 0-2.14-7.59 5 5 0 0 0-9.18 0 4 4 0 0 0-2.14 7.59c.41.2.73.58.73 1.04V20a1 1 0 0 0 1 1Z',
            'M6 17h12',
        ],
    },
    // A dial.
    instruments: { d: ['m12 14 4-4', 'M3.34 19a10 10 0 1 1 17.32 0'] },
    // A knife and fork.
    passage_meals: {
        d: ['M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2', 'M7 2v20', 'M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7'],
    },
    // A speech bubble.
    passage_chat: { d: ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z'] },
    // A route between two marks.
    passage_route: {
        d: ['M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15'],
        circles: [
            [6, 19, 3],
            [18, 5, 3],
        ],
    },
    // A ticked box.
    passage_checklist: {
        d: ['M21 10.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.5', 'm9 11 3 3L22 4'],
    },
};

/** The register's glyph; an unknown register gets a plain dot. */
export const RegisterGlyph: React.FC<GlyphProps & { register: SharedRegister | string }> = ({
    register,
    className,
}) => {
    const glyph = REGISTER_PATHS[register as SharedRegister];
    return glyph ? (
        <Glyph className={className} d={glyph.d} circles={glyph.circles} />
    ) : (
        <Glyph className={className} d={[]} circles={[[12, 12, 3]]} />
    );
};

export const PlusGlyph: React.FC<GlyphProps> = ({ className }) => (
    <Glyph className={className} d={['M5 12h14', 'M12 5v14']} />
);

export const PencilGlyph: React.FC<GlyphProps> = ({ className }) => (
    <Glyph
        className={className}
        d={[
            'M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z',
            'm15 5 4 4',
        ]}
    />
);

export const TrashGlyph: React.FC<GlyphProps> = ({ className }) => (
    <Glyph
        className={className}
        d={[
            'M3 6h18',
            'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6',
            'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2',
            'M10 11v6',
            'M14 11v6',
        ]}
    />
);

export const UsersGlyph: React.FC<GlyphProps> = ({ className }) => (
    <Glyph
        className={className}
        d={['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75']}
        circles={[[9, 7, 4]]}
    />
);

export const PersonGlyph: React.FC<GlyphProps> = ({ className }) => (
    <Glyph className={className} d={['M20 21a8 8 0 0 0-16 0']} circles={[[12, 8, 5]]} />
);

export const AnchorGlyph: React.FC<GlyphProps> = ({ className }) => (
    <Glyph className={className} d={['M12 22V8', 'M5 12H2a10 10 0 0 0 20 0h-3']} circles={[[12, 5, 3]]} />
);

export const SailboatGlyph: React.FC<GlyphProps> = ({ className }) => (
    <Glyph className={className} d={['M22 18H2a4 4 0 0 0 4 4h12a4 4 0 0 0 4-4Z', 'M21 14 10 2 3 14h18Z', 'M10 2v16']} />
);

export const RouteGlyph: React.FC<GlyphProps> = ({ className }) => (
    <Glyph className={className} d={REGISTER_PATHS.passage_route.d} circles={REGISTER_PATHS.passage_route.circles} />
);

export const SwapGlyph: React.FC<GlyphProps> = ({ className }) => (
    <Glyph className={className} d={['M8 3 4 7l4 4', 'M4 7h16', 'm16 21 4-4-4-4', 'M20 17H4']} />
);

export const LeaveGlyph: React.FC<GlyphProps> = ({ className }) => (
    <Glyph className={className} d={['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9']} />
);

export const ChevronDownGlyph: React.FC<GlyphProps> = ({ className }) => (
    <Glyph className={className} d={['m6 9 6 6 6-6']} />
);

export const WarningGlyph: React.FC<GlyphProps> = ({ className }) => (
    <Glyph
        className={className}
        d={['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01']}
    />
);
