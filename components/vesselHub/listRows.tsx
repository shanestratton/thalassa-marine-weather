/**
 * Vessel Hub list primitives — the collapsible wrapper, the row divider, the
 * Boat Binder sub-heading and the Ship's Office row itself.
 */
import React from 'react';
import { ChevronRight } from './icons';

/** Animated collapsible content wrapper */
export const CollapsibleContent: React.FC<{ open: boolean; children: React.ReactNode }> = ({ open, children }) => (
    <div
        style={{
            display: 'grid',
            gridTemplateRows: open ? '1fr' : '0fr',
            transition: 'grid-template-rows 0.25s ease',
        }}
    >
        <div style={{ overflow: 'hidden' }}>{children}</div>
    </div>
);

/** Divider between list rows */
export const ListDivider: React.FC = () => (
    <div className="mx-4" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }} />
);

/**
 * BinderSubLabel — small uppercase label used inside the Boat
 * Binder collapsible to divide its 9 rows into three logical
 * subgroups (Passage / Inventory & Stores / Reference). Sits
 * between two listContainer cards. Smaller and quieter than a
 * SectionHeader — it's a sub-heading, not a toggle. Slate tone so
 * it doesn't compete with the cyan section header above it.
 */
export const BinderSubLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="px-1 pt-3 pb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">{children}</span>
    </div>
);

/** Ship's Office list row.
 *  When `badgeUrgent` is true, the badge renders red (overdue / needs
 *  immediate action). Default amber (informational pending count). */
export const OfficeRow: React.FC<{
    icon: React.ReactNode;
    label: string;
    status: string;
    statusColor: string;
    onClick: () => void;
    disabled?: boolean;
    badge?: number;
    badgeUrgent?: boolean;
}> = ({ icon, label, status, statusColor, onClick, disabled, badge, badgeUrgent }) => (
    <button
        aria-label={label}
        onClick={onClick}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-all active:scale-[0.98] ${
            disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-white/3'
        }`}
    >
        <div className="p-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }}>
            {icon}
        </div>
        <span className="flex-1 text-[13px] font-bold text-white tracking-wide">{label}</span>
        {badge !== undefined && (
            <span
                className={`px-1.5 py-0.5 text-[11px] font-bold rounded-full ${
                    badgeUrgent ? 'bg-red-500/30 text-red-300 animate-pulse' : 'bg-amber-500/30 text-amber-300'
                }`}
            >
                {badge}
            </span>
        )}
        <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: statusColor }}>
            {status}
        </span>
        <ChevronRight />
    </button>
);
