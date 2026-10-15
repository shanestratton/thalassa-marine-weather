/**
 * One item on a box page (126-11a): its name, a Low chip at or under its
 * minimum, and − count + with 44 pt targets. Taking an impeller is one tap on
 * −. View-only crew get the count alone.
 *
 * 131-B14: the count reads in units, a weight or a volume steps a sensible
 * amount ('Take 100 g'), and Low is the one rule the whole of Stores uses.
 */
import React from 'react';
import type { InventoryItem, StoresBox } from '../../../types';
import { isLowStock } from '../../../services/vessel/inventoryStats';
import {
    hasStock,
    storesAmount,
    storesStep,
    storesStepDelta,
    type StoresUnitSystem,
} from '../../../services/vessel/storesUnits';

/** "Engine room · 7 items · 1 low". */
export function boxLine(box: StoresBox, items: InventoryItem[]): string {
    const low = items.filter(isLowStock).length;
    return [box.location_zone, `${items.length} item${items.length === 1 ? '' : 's'}`, low && `${low} low`]
        .filter(Boolean)
        .join(' · ');
}

/** A tappable row in the Boxes list and the item picker: a name, and a line under it. */
export const ListRow: React.FC<{ title: string; line?: string | null; on?: boolean; onClick: () => void }> = ({
    title,
    line,
    on,
    onClick,
}) => (
    <button
        aria-pressed={on}
        onClick={onClick}
        className={`block min-h-[44px] w-full rounded-xl border border-white/5 bg-white/5 px-3 py-1.5 text-left ${on ? 'outline-2 outline-sky-400' : ''}`}
    >
        <span className="block text-sm font-bold">{title}</span>
        <span className="block text-xs text-gray-400">{line}</span>
    </button>
);

export const BoxItemRow: React.FC<{
    item: InventoryItem;
    units: StoresUnitSystem;
    onAdjust?: (id: string, delta: number) => void;
}> = ({ item, units, onAdjust }) => {
    const amount = storesAmount(item.quantity, item.unit, units);
    /** "one" for a count, "100 g" for a weight. */
    const size = storesStep(item.quantity, item.unit, units).label ?? 'one';
    /** − or + at 44 pt; − is off at nothing left. */
    const step = (direction: 1 | -1, label: string, colour: string) =>
        onAdjust && (
            <button
                aria-label={`${label} ${size} ${item.item_name}`}
                disabled={direction < 0 && !hasStock(item.quantity)}
                onClick={() => onAdjust(item.id, storesStepDelta(item.quantity, item.unit, direction, units))}
                className={`size-[44px] shrink-0 rounded-xl font-bold disabled:opacity-30 ${colour}`}
            >
                {direction < 0 ? '−' : '+'}
            </button>
        );
    return (
        <li className="flex min-h-[44px] items-center gap-2 py-1 text-white">
            <span className="min-w-0 flex-1 text-sm font-bold [overflow-wrap:anywhere]">
                <span>{item.item_name}</span>
                {isLowStock(item) && <span className="ml-2 text-micro font-black uppercase text-amber-400">Low</span>}
            </span>
            {step(-1, 'Take', 'bg-red-500/15 text-red-400')}
            <span
                role="status"
                aria-label={`${item.item_name}: ${amount}`}
                className="min-w-8 text-center text-lg font-black tabular-nums whitespace-nowrap"
            >
                {amount}
            </span>
            {step(1, 'Add', 'bg-emerald-500/15 text-emerald-400')}
        </li>
    );
};
