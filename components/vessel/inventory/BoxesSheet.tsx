/**
 * Boxes in Ship's Stores (126-11a): the Boxes list, a box's page, putting
 * items in, and making, renaming or deleting a box. One sheet at a time, each
 * a ModalSheet inside the Stores page (centred, clear of the tab bar, scrolling
 * inside itself). The page owns which box is open (`view`), so openBox() can
 * open one by id.
 */
import React, { useRef, useState } from 'react';
import type { InventoryItem, StoresBox } from '../../../types';
import { StoresBoxService, boxesNotLive } from '../../../services/vessel/StoresBoxService';
import { ModalSheet } from '../../ui/ModalSheet';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { FormField } from '../../ui/FormField';
import { toast } from '../../Toast';
import { BoxSheet } from './BoxSheet';
import { PutItemsSheet } from './PutItemsSheet';
import { ListRow, boxLine } from './BoxItemRow';

/** Closed; the Boxes list (id null); or one box (`back` returns to the list). */
export type BoxView = { id: string | null; back?: boolean } | null;

/**
 * New box, or Edit box (and Delete, for the owner: its items stay in Stores).
 * Delete asks first, in a dialog of its own: one stray tap on a rolling boat
 * must not lose the box's id (and with it the tag on the box, 126-11b).
 */
const BoxForm: React.FC<{
    box?: StoresBox;
    /** A write is running: Save waits. */
    busy: boolean;
    onClose: () => void;
    onSave: (name: string, zone: string) => void;
    onDelete?: () => Promise<void>;
}> = ({ box, busy, onClose, onSave, onDelete }) => {
    const [name, setName] = useState(box?.name ?? '');
    const [zone, setZone] = useState(box?.location_zone ?? '');
    const [sure, setSure] = useState(false);
    return (
        <ModalSheet isOpen onClose={onClose} title={box ? 'Edit box' : 'New box'}>
            <div className="space-y-2">
                <FormField label="Box name" value={name} onChange={(v) => setName(v.slice(0, 80))} required />
                <FormField
                    label="Zone"
                    value={zone}
                    onChange={(v) => setZone(v.slice(0, 80))}
                    placeholder="Engine room"
                />
                <Button
                    variant="primary"
                    className="w-full"
                    disabled={!name.trim() || busy}
                    onClick={() => onSave(name, zone)}
                >
                    Save box
                </Button>
                {onDelete && (
                    <Button variant="danger" className="w-full" onClick={() => setSure(true)}>
                        Delete box (its items stay in Stores)
                    </Button>
                )}
            </div>
            {onDelete && (
                <ConfirmDialog
                    isOpen={sure}
                    destructive
                    title={`Delete ${box!.name}?`}
                    message="Its items stay in Ship's Stores, not in a box."
                    confirmLabel="Delete box"
                    onConfirm={async () => {
                        await onDelete();
                        setSure(false);
                    }}
                    onCancel={() => setSure(false)}
                />
            )}
        </ModalSheet>
    );
};

export const StoresBoxes: React.FC<{
    view: BoxView;
    setView: (view: BoxView) => void;
    /** Every item on the Stores page, and its boxes. */
    items: InventoryItem[];
    boxes: StoresBox[];
    /** The server has stores_boxes: until then nothing is written. */
    live: boolean;
    /** May add to and change this Stores (not view-only crew). */
    editable: boolean;
    /** May delete from it (its owner). */
    canDelete: boolean;
    onAdjust?: (id: string, delta: number) => void;
    /** "New item here": the Stores Add form, born in this box. */
    onNewItem: (box: StoresBox) => void;
    /** Re-read the page after a write (resolves once it has). */
    reload: () => Promise<void>;
    /** Scan box (126-11b): only on an iPhone with NFC; reading a tag is for crew too. */
    onScan?: () => void;
}> = ({ view, setView, items, boxes, live, editable, canDelete, onAdjust, onNewItem, reload, onScan }) => {
    const [sheet, setSheet] = useState<'put' | 'form' | null>(null);
    // One write at a time: a second tap while the first is still writing
    // would make a second box, or put the items twice.
    const busyRef = useRef(false);
    const [busy, setBusy] = useState(false);
    if (!view) return null;
    const close = () => setSheet(null);
    /**
     * A write, then the page re-read (so a new box is on the page before it
     * opens); a refusal is said in words. Resolves the result (true when there
     * is none) once it landed, false when it did not or another write runs.
     */
    const run = async (write: () => Promise<unknown>) => {
        if (busyRef.current) return false;
        busyRef.current = true;
        setBusy(true);
        try {
            const result = await write();
            await reload();
            return result || true;
        } catch (e) {
            toast.error((e as Error).message);
            return false;
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    };
    const inBox = (id: string) => items.filter((item) => item.box_id === id);

    if (view.id === null) {
        return sheet ? (
            <BoxForm
                busy={busy}
                onClose={close}
                onSave={async (name, zone) => {
                    const made = (await run(() => StoresBoxService.create({ name, location_zone: zone }))) as StoresBox;
                    if (made) setView({ id: made.id, back: true });
                }}
            />
        ) : (
            <ModalSheet isOpen onClose={() => setView(null)} title="Boxes">
                {live ? (
                    <div className="space-y-1.5 text-white">
                        {!boxes.length && <p className="text-sm text-gray-400">No boxes yet.</p>}
                        {boxes.map((box) => (
                            <ListRow
                                key={box.id}
                                title={box.name}
                                line={boxLine(box, inBox(box.id))}
                                onClick={() => setView({ id: box.id, back: true })}
                            />
                        ))}
                        {editable && (
                            <Button className="mt-3 w-full" onClick={() => setSheet('form')}>
                                New box
                            </Button>
                        )}
                        {onScan && (
                            <Button className="mt-3 w-full" onClick={onScan}>
                                Scan box
                            </Button>
                        )}
                    </div>
                ) : (
                    <p className="text-sm text-gray-300">{boxesNotLive()}.</p>
                )}
            </ModalSheet>
        );
    }

    const box = (live && boxes.find((b) => b.id === view.id)) || null;
    if (box && sheet === 'put') {
        return (
            <PutItemsSheet
                box={box}
                items={items}
                busy={busy}
                onClose={close}
                onPut={async (ids) => {
                    if (await run(() => StoresBoxService.putItems(box.id, ids))) close();
                }}
            />
        );
    }
    if (box && sheet) {
        return (
            <BoxForm
                box={box}
                busy={busy}
                onClose={close}
                onSave={async (name, zone) => {
                    if (await run(() => StoresBoxService.edit(box.id, name, zone))) close();
                }}
                onDelete={
                    canDelete
                        ? async () => {
                              if (await run(() => StoresBoxService.delete(box.id))) setView({ id: null });
                          }
                        : undefined
                }
            />
        );
    }
    return (
        <BoxSheet
            box={box}
            items={box ? inBox(box.id) : []}
            editable={editable}
            onAdjust={onAdjust}
            onClose={() => setView(view.back && box ? { id: null } : null)}
            onPut={() => setSheet('put')}
            onEdit={() => setSheet('form')}
            onNewItem={() => onNewItem(box!)}
        />
    );
};
