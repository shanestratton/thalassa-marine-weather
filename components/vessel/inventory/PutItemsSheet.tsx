/**
 * "Put items in this box" (126-11a): pick from the existing Stores items
 * (search, several at once). An item already in another box moves; the line
 * under its name says where it is now.
 */
import React, { useState } from 'react';
import type { InventoryItem, StoresBox } from '../../../types';
import { ModalSheet } from '../../ui/ModalSheet';
import { Button } from '../../ui/Button';
import { FormField } from '../../ui/FormField';
import { ListRow } from './BoxItemRow';

export const PutItemsSheet: React.FC<{
    box: StoresBox;
    /** Every item on the Stores page. */
    items: InventoryItem[];
    /** A write is running: Put waits. */
    busy: boolean;
    onClose: () => void;
    onPut: (itemIds: string[]) => void;
}> = ({ box, items, busy, onClose, onPut }) => {
    const [search, setSearch] = useState('');
    const [picked, setPicked] = useState<string[]>([]);
    const q = search.trim().toLowerCase();
    const n = picked.length;

    return (
        <ModalSheet isOpen onClose={onClose} title={`Put items in ${box.name}`}>
            <FormField label="Search items" value={search} onChange={setSearch} placeholder="Search Ship's Stores…" />
            <div className="mt-2 space-y-1 text-white">
                {items
                    .filter((item) => item.box_id !== box.id && item.item_name.toLowerCase().includes(q))
                    .sort((a, b) => a.item_name.localeCompare(b.item_name))
                    .map((item) => {
                        const on = picked.includes(item.id);
                        return (
                            <ListRow
                                key={item.id}
                                title={item.item_name}
                                line={item.location_specific}
                                on={on}
                                onClick={() =>
                                    setPicked(on ? picked.filter((id) => id !== item.id) : [...picked, item.id])
                                }
                            />
                        );
                    })}
            </div>
            <Button variant="primary" className="mt-3 w-full" disabled={!n || busy} onClick={() => onPut(picked)}>
                Put {n || ''} {n === 1 ? 'item' : 'items'} in this box
            </Button>
        </ModalSheet>
    );
};
