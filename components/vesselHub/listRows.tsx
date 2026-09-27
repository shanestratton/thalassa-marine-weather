/**
 * Vessel Hub list primitives — the collapsible wrapper, the row divider, the
 * Boat Binder sub-heading and the hub list row itself.
 */
import React, { useCallback, useId } from 'react';
import { ChevronRight } from './icons';
import { SectionLabel } from './SectionHeader';
import { daylightUiColor } from '../../utils/daylightUiColor';

/** Animated collapsible content wrapper.
 *
 *  A collapsed panel is 0px tall but its rows used to stay in the tab order
 *  and the accessibility tree — a screen reader walked straight into "Music"
 *  and "NMEA Gateway" under a header that said Atmosphere / Settings were
 *  closed (UX referee, 2026-09-26). So the inner panel is `inert`, hidden
 *  from assistive tech, and `visibility: hidden` once the close animation has
 *  finished; opening shows it at once so the grow animation is visible. The
 *  outer element stays the one that animates — SectionHeader waits on its
 *  transition before scrolling the section into view — and carries the `id`
 *  its header's aria-controls names. */
export const CollapsibleContent: React.FC<{ open: boolean; children: React.ReactNode; id?: string }> = ({
    open,
    children,
    id,
}) => {
    // React 18 has no `inert` prop; set the DOM property directly (same
    // pattern as Dashboard's collapsed layers).
    const setInert = useCallback(
        (element: HTMLDivElement | null) => {
            if (element) (element as HTMLDivElement & { inert: boolean }).inert = !open;
        },
        [open],
    );
    return (
        <div
            id={id}
            style={{
                display: 'grid',
                gridTemplateRows: open ? '1fr' : '0fr',
                transition: 'grid-template-rows 0.25s ease',
            }}
        >
            <div
                ref={setInert}
                aria-hidden={open ? undefined : true}
                style={{
                    overflow: 'hidden',
                    visibility: open ? 'visible' : 'hidden',
                    // Hide only after the 0.25s close has run; show at once on open.
                    transition: open ? 'visibility 0s' : 'visibility 0s linear 0.25s',
                }}
            >
                {children}
            </div>
        </div>
    );
};

/** Divider between list rows */
export const ListDivider: React.FC = () => (
    <div className="mx-4" style={{ borderTop: '1px solid var(--day-ui-border, rgba(255,255,255,0.04))' }} />
);

/**
 * BinderSubLabel — the label on the Boat Binder screen that divides its rows
 * into subgroups (Inventory & Stores / Reference). Sits between two
 * listContainer cards. It wears the hub's one section-label style (the
 * Settings pages' dot and caps) rather than a grey variant of its own (UX
 * scorecard run 7, C-section-heading-styles).
 */
export const BinderSubLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <SectionLabel className="px-1 pt-3 pb-1.5">{children}</SectionLabel>
);

/** Vessel hub list row.
 *
 *  ONE ANATOMY for every row on the hub (UX referee 2026-09-26): the title,
 *  then `status` as a sentence-case subtitle beneath it — the same shape as
 *  the Diary and Boat Binder cards. It says what the row is for, or, when
 *  there is something live to say ("2 overdue"), says that in its colour. It
 *  wraps rather than truncates: the old right-aligned uppercase status was
 *  capped at half the row and cut "connect when aboard" to "CONNECT WH…".
 *
 *  `value` is ONLY for a short live value ("2 crew") — never a description —
 *  so it may sit on the right without squeezing the title. It never wraps, so
 *  the row's height cannot jump when it loads (Shane 2026-09-04: the Passage
 *  Planning row grew, then settled, as "Plan Your Voyage" became "3 CREW").
 *
 *  When `badgeUrgent` is true, the badge renders red (overdue / needs
 *  immediate action). Default amber (informational pending count). */
export const OfficeRow: React.FC<{
    icon: React.ReactNode;
    label: string;
    /** The line under the title: what the row is for, or its live state. */
    status: string;
    statusColor: string;
    /** Short live value on the right ("2 crew") — never a description. */
    value?: string;
    valueColor?: string;
    onClick: () => void;
    disabled?: boolean;
    badge?: number;
    badgeUrgent?: boolean;
}> = ({ icon, label, status, statusColor, value, valueColor, onClick, disabled, badge, badgeUrgent }) => {
    // The name stays the bare title (tests and voice commands find rows by
    // it); the status line and any live value are read as its description.
    const id = useId();
    return (
        <button
            aria-label={label}
            aria-describedby={value ? `${id}-status ${id}-value` : `${id}-status`}
            onClick={onClick}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-all active:scale-[0.98] ${
                disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-white/3'
            }`}
        >
            <div
                aria-hidden="true"
                className="shrink-0 p-1.5 rounded-lg"
                style={{ background: 'var(--day-ui-surface-soft, rgba(255,255,255,0.04))' }}
            >
                {icon}
            </div>
            <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-black leading-tight tracking-wide text-white">{label}</span>
                <span
                    id={`${id}-status`}
                    className="mt-0.5 block text-xs font-semibold leading-snug"
                    style={{ color: daylightUiColor(statusColor) }}
                >
                    {status}
                </span>
            </span>
            {badge !== undefined && (
                <span
                    aria-hidden="true"
                    className={`shrink-0 px-1.5 py-0.5 text-xs font-bold rounded-full ${
                        badgeUrgent ? 'bg-red-500/30 text-red-300 animate-pulse' : 'bg-amber-500/30 text-amber-300'
                    }`}
                >
                    {badge}
                </span>
            )}
            {value && (
                <span
                    id={`${id}-value`}
                    className="shrink-0 whitespace-nowrap text-xs font-bold"
                    style={{ color: valueColor ? daylightUiColor(valueColor) : undefined }}
                >
                    {value}
                </span>
            )}
            <span aria-hidden="true" className="shrink-0">
                <ChevronRight />
            </span>
        </button>
    );
};
