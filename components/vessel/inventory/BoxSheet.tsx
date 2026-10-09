/**
 * The box page (126-11a): everything in one box, with −1 for the one you took,
 * "Put items in this box", and "New item here" (the Stores Add form, born in
 * this box). A ModalSheet inside the Stores page (centred, clear of
 * the tab bar, scrolling inside itself). Opened from the Boxes list, or by id
 * through openBox(), which 126-11b's tag link calls.
 */
import React from 'react';
import type { InventoryItem, StoresBox } from '../../../types';
import { BOX_NOT_HERE } from '../../../services/vessel/StoresBoxService';
import { ModalSheet } from '../../ui/ModalSheet';
import { Button } from '../../ui/Button';
import { BoxItemRow, boxLine } from './BoxItemRow';

export const BoxSheet: React.FC<{
    box: StoresBox | null;
    /** The items in this box. */
    items: InventoryItem[];
    /** May add to and change this Stores (false for view-only crew). */
    editable: boolean;
    onAdjust?: (id: string, delta: number) => void;
    onClose: () => void;
    onPut: () => void;
    onEdit: () => void;
    onNewItem: () => void;
}> = ({ box, items, editable, onAdjust, onClose, onPut, onEdit, onNewItem }) =>
    box ? (
        <ModalSheet isOpen onClose={onClose} title={box.name}>
            <div className="text-white">
                <div className="mb-2 flex items-center gap-2">
                    <p className="flex-1 text-xs font-bold uppercase tracking-widest text-gray-400">
                        {boxLine(box, items)}
                    </p>
                    {editable && (
                        <Button aria-label="Edit box" onClick={onEdit}>
                            Edit
                        </Button>
                    )}
                </div>
                {items.length ? (
                    <ul className="divide-y divide-white/5">
                        {[...items]
                            .sort((a, b) => a.item_name.localeCompare(b.item_name))
                            .map((item) => (
                                <BoxItemRow key={item.id} item={item} onAdjust={onAdjust} />
                            ))}
                    </ul>
                ) : (
                    <p className="py-4 text-center text-sm text-gray-400">Nothing in this box yet.</p>
                )}
                {editable && (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                        <Button onClick={onPut}>Put items in this box</Button>
                        <Button onClick={onNewItem}>New item here</Button>
                    </div>
                )}
            </div>
        </ModalSheet>
    ) : (
        <ModalSheet isOpen onClose={onClose} title="Box">
            <p className="text-sm text-gray-300">{BOX_NOT_HERE}.</p>
        </ModalSheet>
    );
