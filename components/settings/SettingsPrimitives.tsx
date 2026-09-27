/**
 * Shared primitive UI components for Settings panels.
 * Section, Row, Toggle — used by all settings tabs.
 */
import React from 'react';
import { triggerHaptic } from '../../utils/system';
import { SignInButton } from '../ui/SignInButton';

// ── Field label ──────────────────────────────────────────────────
/** The one label for a form field in Settings: small grey capitals above the
 *  field. Preferences had three (white sentence case 'Default port', grey caps
 *  with no tracking 'WIND SPEED', grey caps at the widest tracking 'VESSEL
 *  NAME'); every form label now wears this one (UX scorecard run 8). A row
 *  title beside a switch stays 14 px white — that is a title, not a label. */
export const FIELD_LABEL_CLASS = 'block mb-1.5 text-xs font-bold uppercase tracking-wider text-gray-400';

// ── SignInCard ───────────────────────────────────────────────────
/** The one sign-in card in Settings: a left-aligned title and the reason,
 *  then a full-width 44 pt SignInButton under them. Account & Cloud had a
 *  centred hero and Voyage Log a button squeezed beside its title, which
 *  orphaned 'Log' on a line of its own (UX scorecard run 8). The caller
 *  supplies the card chrome, so it sits in a Section row or a card alike. */
export const SignInCard: React.FC<{
    title: string;
    reason: React.ReactNode;
    onSignIn: () => void;
    icon?: React.ReactNode;
    /** h2 where the card leads the page, h3 inside a Section. */
    headingLevel?: 'h2' | 'h3';
}> = ({ title, reason, onSignIn, icon, headingLevel = 'h3' }) => {
    const Heading = headingLevel;
    return (
        <div className="space-y-4">
            <div className="flex items-start gap-3">
                {icon && (
                    <div className="shrink-0 rounded-xl bg-white/5 p-2.5 text-gray-300" aria-hidden="true">
                        {icon}
                    </div>
                )}
                <div className="min-w-0 flex-1">
                    <Heading className="text-sm font-bold text-white">{title}</Heading>
                    <p className="mt-1 text-xs text-gray-400">{reason}</p>
                </div>
            </div>
            <SignInButton fullWidth onClick={onSignIn} />
        </div>
    );
};

// ── Section ──────────────────────────────────────────────────
// `tone="danger"` gives a destructive section (Factory Reset) the red-bar
// heading Vessel Profile's Comfort Zone already uses, so it no longer wears
// the same cyan bullet as every benign section.
export const Section = React.memo(
    ({
        title,
        children,
        tone = 'default',
    }: {
        title: string;
        children?: React.ReactNode;
        tone?: 'default' | 'danger';
    }) => {
        const danger = tone === 'danger';
        return (
            <div className="space-y-4 mb-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <h2
                    className={`ui-section-heading uppercase tracking-[0.15em] px-1 flex items-center gap-2 ${
                        danger ? 'text-red-400' : 'text-sky-300'
                    }`}
                >
                    {danger ? (
                        <div className="w-1 h-4 rounded-full bg-red-500" aria-hidden="true"></div>
                    ) : (
                        <div
                            className="w-1.5 h-1.5 shrink-0 rounded-full bg-sky-500 shadow-lg shadow-sky-500/50"
                            aria-hidden="true"
                        ></div>
                    )}
                    {title}
                </h2>
                <div
                    className={`bg-white/3 border rounded-2xl overflow-hidden shadow-lg shadow-black/10 ${
                        danger ? 'border-red-500/20' : 'border-white/6'
                    }`}
                >
                    {children}
                </div>
            </div>
        );
    },
);
Section.displayName = 'Section';

// ── SubSection ───────────────────────────────────────────────────
/** A titled block inside a Section card, split from its neighbours by the
 *  card's row divider. The h3 sits under the Section's h2, so a long form
 *  (Vessel Profile) keeps one heading style, one card width and a heading
 *  per block for VoiceOver's rotor instead of a coloured bar per block. */
export const SubSection: React.FC<{
    title?: string;
    /** A short note set right of the title ("Auto unless you set it"). */
    aside?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}> = ({ title, aside, children, className = '' }) => (
    <div className={`p-4 border-b border-white/5 last:border-0 ${className}`}>
        {title && (
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h3 className="text-sm font-bold text-white">{title}</h3>
                {aside && <span className="text-xs text-gray-400">{aside}</span>}
            </div>
        )}
        {children}
    </div>
);

// ── SatelliteModeGlyph ───────────────────────────────────────────
/** Satellite mode's dish, shared by its switch (Preferences) and the line
 *  that points to it (Account & Cloud). */
export const SatelliteModeGlyph: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
    <svg
        aria-hidden="true"
        className={className}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
    >
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8.288 15.038a5.25 5.25 0 017.424-7.424m-5.303 5.303a2.25 2.25 0 013.182-3.182M12 21a9 9 0 100-18 9 9 0 000 18z"
        />
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 7.5l16.5 9" />
    </svg>
);

// ── RowChevron ───────────────────────────────────────────────────
/** "Opens a page" — the same chevron the Vessel hub rows use, so the two
 *  hubs speak one glyph (a right ARROW here read as a different action). */
export const RowChevron: React.FC<{ className?: string }> = ({ className = 'w-4 h-4 text-gray-400' }) => (
    <svg
        aria-hidden="true"
        className={`shrink-0 ${className}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
    >
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
);

// ── Row ──────────────────────────────────────────────────────────
export const Row = React.memo(
    ({
        children,
        className = '',
        onClick,
        label,
    }: {
        children: React.ReactNode;
        className?: string;
        onClick?: () => void;
        label?: string;
    }) => {
        const baseClass = `p-4 border-b border-white/5 last:border-0 flex items-center justify-between gap-4 ${className}`;

        // When clickable, render as a proper button for keyboard accessibility
        if (onClick) {
            return (
                <button
                    className={`${baseClass} cursor-pointer hover:bg-white/5 transition-colors w-full text-left`}
                    onClick={onClick}
                    aria-label={label}
                >
                    {children}
                </button>
            );
        }

        return <div className={baseClass}>{children}</div>;
    },
);
Row.displayName = 'Row';

// ── Toggle ───────────────────────────────────────────────────────
/** The off track is slate-500: slate-700 measured 1.68:1 on the dark card, so
 *  in glare an off switch read as a loose white dot (UX scorecard run 9).
 *  Slate-500 is ~3.7:1 on the dark card and ~4.5:1 on the daylight card, and
 *  the white knob stays ~4.8:1 on it. Daylight needs no remap of its own. */
export const Toggle = React.memo(
    ({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) => (
        <button
            role="switch"
            aria-checked={checked}
            aria-label={label}
            className="relative inline-flex items-center cursor-pointer py-2.5 px-2 -mr-2 group"
            onClick={(e) => {
                e.stopPropagation();
                void triggerHaptic('light');
                onChange(!checked);
            }}
        >
            <div
                className={`w-11 h-6 rounded-full transition-all duration-300 ${
                    checked ? 'bg-linear-to-r from-sky-500 to-sky-600 shadow-lg shadow-sky-500/30' : 'bg-slate-500'
                }`}
            >
                <div
                    className={`absolute top-3.5 w-4 h-4 bg-white rounded-full shadow-md transition-all duration-300 ${checked ? 'left-8' : 'left-3'}`}
                ></div>
            </div>
        </button>
    ),
);
Toggle.displayName = 'Toggle';

// ── Common props passed to every settings tab ────────────────
import { UserSettings } from '../../types';

export interface SettingsTabProps {
    settings: UserSettings;
    onSave: (settings: Partial<UserSettings>) => void;
}
