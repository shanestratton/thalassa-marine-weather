/**
 * Shared primitive UI components for Settings panels.
 * Section, Row, Toggle — used by all settings tabs.
 */
import React from 'react';
import { triggerHaptic } from '../../utils/system';

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
                        <div className="w-1.5 h-1.5 rounded-full bg-sky-500 shadow-lg shadow-sky-500/50"></div>
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
                    checked ? 'bg-linear-to-r from-sky-500 to-sky-600 shadow-lg shadow-sky-500/30' : 'bg-slate-700'
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
