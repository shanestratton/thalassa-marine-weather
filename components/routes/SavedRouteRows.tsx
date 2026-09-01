/**
 * The saved-routes visual grammar, shared by every surface that lists routes.
 *
 * Extracted verbatim from components/crew/SavedRoutePicker (the layout Shane
 * called the gold standard, 2026-08-30) so the PLAN tab's saved-routes modal
 * and the cast-off "Following a route?" sheet can wear it without a second
 * copy of the markup.
 *
 * These render INLINE. They are deliberately not a sheet: the two surfaces
 * adopting them are already inside body portals of their own (RoutePlanner's
 * picker at z-[10060], the cast-off sheet at z-[10055]), and OverlayPortal
 * mounts at zIndex 1100 — so a nested sheet would render UNDERNEATH its own
 * host. Giving each host the rows and letting it keep its own container is
 * what makes this shareable at all.
 */
import React from 'react';
import type { SavedRoutePickerRow } from '../../services/savedRouteOrder';
import { triggerHaptic } from '../../utils/system';

/**
 * The whole-trip row is a HEADING, not a choice (Shane 2026-08-27: "the punter
 * can not select the actual passage. it should just be there so the legs make
 * sense") — the legs beneath are the sailable units.
 */
export const SavedRoutePassageHeading: React.FC<{ row: SavedRoutePickerRow }> = ({ row }) => (
    <div
        role="presentation"
        className="flex items-center gap-3 rounded-xl border border-violet-400/25 bg-violet-500/8 px-3 py-2.5"
    >
        <span aria-hidden="true" className="text-base leading-none">
            🧭
        </span>
        <span className="flex-1 min-w-0">
            <span className="block truncate text-sm font-black text-violet-100">{row.name}</span>
            {row.detail && <span className="block text-[11px] text-violet-300/60">{row.detail}</span>}
        </span>
        <span className="shrink-0 rounded-md border border-violet-400/30 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.15em] text-violet-300">
            Passage
        </span>
    </div>
);

/**
 * A selectable route. Legs are marked by the ↳ glyph alone and sit FLUSH with
 * standalone routes — not indented (Shane 2026-08-27: "not have the legs
 * indented").
 *
 * The leg badge sits OUTSIDE the truncating name span so a long route name can
 * never eat it on a narrow screen.
 */
export const SavedRouteOptionRow: React.FC<{
    row: SavedRoutePickerRow;
    selected: boolean;
    onSelect: (id: string) => void;
}> = ({ row, selected, onSelect }) => (
    <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={() => {
            triggerHaptic('light');
            onSelect(row.id);
        }}
        className={`w-full flex items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors ${
            selected ? 'bg-violet-500/[0.14] border-violet-400/40' : 'bg-white/3 border-white/8 hover:bg-white/6'
        }`}
    >
        <span aria-hidden="true" className="text-base leading-none">
            {row.kind === 'leg' ? '↳' : '📍'}
        </span>
        <span className="flex-1 min-w-0">
            <span className="flex items-baseline gap-1.5 text-sm font-semibold text-slate-100">
                <span className="min-w-0 truncate">{row.name}</span>
                {row.legBadge && <span className="shrink-0">{row.legBadge}</span>}
            </span>
            {row.detail && <span className="block text-[11px] text-gray-500">{row.detail}</span>}
        </span>
        {selected && (
            <span aria-hidden="true" className="text-violet-300 font-black">
                ✓
            </span>
        )}
    </button>
);

/**
 * The listbox body: ordered rows, headings rendered as headings.
 *
 * `listboxId` is caller-supplied rather than a literal. Two mounted instances
 * sharing one hard-coded id would emit duplicate DOM ids and make
 * `getByRole('listbox', { name: ... })` ambiguous — which is exactly what
 * happens once a second surface adopts this.
 */
export const SavedRouteList: React.FC<{
    rows: SavedRoutePickerRow[];
    selectedId?: string;
    onSelect: (id: string) => void;
    listboxId: string;
    label?: string;
    className?: string;
    children?: React.ReactNode;
}> = ({ rows, selectedId, onSelect, listboxId, label = 'Saved Routes', className, children }) => (
    <div
        id={listboxId}
        role="listbox"
        aria-label={label}
        className={className ?? 'flex-1 overflow-y-auto px-3 py-3 space-y-1.5'}
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
    >
        {children}
        {rows.map((row) =>
            row.kind === 'passage' ? (
                <SavedRoutePassageHeading key={row.id} row={row} />
            ) : (
                <SavedRouteOptionRow key={row.id} row={row} selected={row.id === selectedId} onSelect={onSelect} />
            ),
        )}
    </div>
);
