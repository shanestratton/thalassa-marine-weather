/**
 * InventoryScanner — the Add item sheet for Ship's Stores, with Scan.
 *
 * Scan reads a barcode (services/native/scanBarcode: the iPhone's scanner, or
 * the camera in a browser). A code already in Stores opens that item to change
 * its count, on the page's own ± path, instead of making a second one; a new
 * code fills the Barcode field. A camera Thalassa may not use, or a scanner
 * that isn't there, is said in the sheet (131-B13).
 *
 * 131-B13: the full-screen camera this file used to open was never shown (the
 * one place that opens it went straight to this form), and the only "found it,
 * change the count" view went with it, so a scanned item already in Stores was
 * made again.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';
import type { InventoryItem, InventoryCategory, StoresBox } from '../../types';
import { LocalInventoryService as InventoryService } from '../../services/vessel/LocalInventoryService';
import { isLowStock } from '../../services/vessel/inventoryStats';
import { scanBarcode, type BarcodeScan } from '../../services/native/scanBarcode';
import { triggerHaptic } from '../../utils/system';
import { toast } from '../Toast';
import { FormField } from '../ui/FormField';
import { ModalSheet } from '../ui/ModalSheet';
import { Button } from '../ui/Button';
import { AlertTriangleIcon, MapPinIcon } from '../Icons';
import { StoresCategoryGrid } from './inventory/StoresCategoryGrid';

const log = createLogger('InventoryScanner');

interface InventoryScannerProps {
    onClose: () => void;
    onItemSaved: () => void; // Refresh parent list
    /** "New item here" on a box page (126-11a): born in this box, at its place. */
    box?: StoresBox;
    /**
     * The Stores page's ± (131-B13): a delta, one at a time, with the shopping
     * list for low stock as on the cards and the box page. Resolves the row as
     * it now stands (null when nothing changed).
     */
    onAdjust: (id: string, delta: number) => Promise<InventoryItem | null>;
}

/** A count typed into the form: a number, never below nothing (131-B13). */
const count = (typed: string) => Math.max(0, parseInt(typed) || 0);

export const InventoryScanner: React.FC<InventoryScannerProps> = ({ onClose, onItemSaved, box, onAdjust }) => {
    // ── Scan ──
    /** What the last scan could not do, in words, under the Barcode field. */
    const [scanProblem, setScanProblem] = useState<string | null>(null);
    /** The browser's camera, in the sheet (the iPhone's scanner is its own screen). */
    const [webCamera, setWebCamera] = useState(false);
    const videoRef = useRef<HTMLVideoElement>(null);
    /** The item a scanned code is already on: the sheet shows its count to change. */
    const [found, setFound] = useState<InventoryItem | null>(null);

    // ── New item form ──
    const [newItem, setNewItem] = useState({
        item_name: '',
        barcode: '',
        category: 'Provisions' as InventoryCategory,
        quantity: 1,
        min_quantity: 0,
        unit: 'whole',
        location_zone: box?.location_zone ?? '',
        location_specific: box?.name ?? '',
        description: '',
        expiry_date: '',
    });
    // One Add at a time: state lands a render late, so the ref is the guard.
    const savingRef = useRef(false);
    const [saving, setSaving] = useState(false);

    /** A scanned code: the item it is already on, or the Barcode field. */
    const take = async (result: BarcodeScan) => {
        if (result.code === null) {
            setScanProblem(result.problem);
            return;
        }
        const code = result.code;
        triggerHaptic('medium');
        try {
            const existing = await InventoryService.findByBarcode(code);
            if (existing) {
                setFound(existing);
                return;
            }
        } catch (e) {
            log.warn(' barcode look-up failed:', e);
        }
        setNewItem((prev) => ({ ...prev, barcode: code }));
    };

    // The browser's camera runs while its <video> is in the sheet; closing it,
    // or the sheet, aborts the scan and puts the camera out.
    useEffect(() => {
        if (!webCamera) return;
        const stop = new AbortController();
        void scanBarcode({ video: videoRef.current, signal: stop.signal }).then((result) => {
            if (stop.signal.aborted) return;
            setWebCamera(false);
            void take(result);
        });
        return () => stop.abort();
    }, [webCamera]);

    const scan = async () => {
        setScanProblem(null);
        if (!Capacitor.isNativePlatform()) {
            setWebCamera(true);
            return;
        }
        await take(await scanBarcode());
    };

    // ── Save new item ──
    const handleSaveNew = async () => {
        if (!newItem.item_name.trim() || savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        try {
            await InventoryService.create({
                ...newItem,
                ...(box && { box_id: box.id }),
                barcode: newItem.barcode || null,
                location_zone: newItem.location_zone || null,
                location_specific: newItem.location_specific || null,
                description: newItem.description || null,
                expiry_date: newItem.expiry_date || null,
            });
            triggerHaptic('medium');
            onItemSaved();
            toast.success("Item added to Ship's Stores");
            onClose();
        } catch (e) {
            log.warn(' save failed:', e);
            toast.error('Failed to save item');
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    };

    // ── Add item form via ModalSheet (keyboard-aware) ──
    if (!found) {
        return (
            <ModalSheet isOpen={true} onClose={onClose} title={box ? `Add to ${box.name}` : 'Add item'} zIndex="z-2000">
                <div className="space-y-2">
                    {/* Category — first */}
                    <div>
                        <label className="text-label font-bold text-gray-400 uppercase tracking-widest">Category</label>
                        <StoresCategoryGrid
                            value={newItem.category}
                            onChange={(category) => setNewItem((prev) => ({ ...prev, category }))}
                        />
                    </div>

                    {/* Item name */}
                    <FormField
                        label="Item name"
                        value={newItem.item_name}
                        onChange={(v) => setNewItem((prev) => ({ ...prev, item_name: v }))}
                        placeholder="e.g. Racor 2010PM-OR Fuel Filter"
                        required
                    />

                    {/* Barcode + Scan button */}
                    <div>
                        <label className="text-label font-bold text-gray-400 uppercase tracking-widest">Barcode</label>
                        <div className="flex gap-2 mt-0.5">
                            <input
                                type="text"
                                value={newItem.barcode}
                                onChange={(e) => setNewItem((prev) => ({ ...prev, barcode: e.target.value }))}
                                placeholder="Optional"
                                className="flex-2 min-w-0 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-sm font-mono outline-hidden focus:border-sky-500/30 transition-colors placeholder:text-gray-400"
                            />
                            <button
                                aria-label="Scan barcode"
                                type="button"
                                onClick={() => void scan()}
                                disabled={webCamera}
                                className="flex-1 min-h-11 flex items-center justify-center gap-1.5 bg-sky-600/20 border border-sky-500/30 rounded-xl text-sky-400 text-xs font-bold hover:bg-sky-600/30 transition-colors active:scale-95 disabled:opacity-50"
                            >
                                <svg
                                    className="w-4 h-4"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z"
                                    />
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z"
                                    />
                                </svg>
                                Scan
                            </button>
                        </div>
                        {/* The camera refused, or no scanner here: said where the skipper is looking. */}
                        {scanProblem && (
                            <p role="alert" className="flex items-start gap-1.5 mt-1 text-xs font-bold text-amber-400">
                                <AlertTriangleIcon className="w-3.5 h-3.5 shrink-0 mt-px" />
                                <span>{scanProblem}</span>
                            </p>
                        )}
                    </div>

                    {/* The browser's camera, in the sheet */}
                    {webCamera && (
                        <div className="relative w-full h-40 rounded-xl overflow-hidden border border-sky-500/30 bg-black">
                            <video ref={videoRef} className="w-full h-full object-cover" playsInline muted autoPlay />
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <div className="w-3/4 h-12 border-2 border-sky-400/60 rounded-lg">
                                    <div
                                        className="absolute inset-x-4 h-0.5 bg-sky-400/50 animate-pulse"
                                        style={{ top: '50%' }}
                                    />
                                </div>
                            </div>
                            <div className="absolute bottom-1 left-0 right-0 text-center">
                                <span className="text-label font-bold text-sky-400 animate-pulse uppercase tracking-widest">
                                    Scanning…
                                </span>
                            </div>
                            <button
                                onClick={() => setWebCamera(false)}
                                className="hit-target-44 absolute top-2 right-2 p-1 rounded-full bg-black/60 text-white/70 hover:text-white"
                                aria-label="Close scanner"
                            >
                                <svg
                                    className="w-4 h-4"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    )}

                    {/* Quantity + Min */}
                    <div className="grid grid-cols-2 gap-2">
                        <FormField
                            label="Quantity"
                            type="number"
                            value={newItem.quantity}
                            onChange={(v) => setNewItem((prev) => ({ ...prev, quantity: count(v) }))}
                            min={0}
                        />
                        <FormField
                            label="Min alert"
                            type="number"
                            value={newItem.min_quantity}
                            onChange={(v) => setNewItem((prev) => ({ ...prev, min_quantity: count(v) }))}
                            min={0}
                        />
                    </div>

                    {/* Location */}
                    <div className="grid grid-cols-2 gap-2">
                        <FormField
                            label="Zone"
                            value={newItem.location_zone}
                            onChange={(v) => setNewItem((prev) => ({ ...prev, location_zone: v }))}
                            placeholder="Engine Room"
                        />
                        <FormField
                            label="Exact spot"
                            value={newItem.location_specific}
                            onChange={(v) => setNewItem((prev) => ({ ...prev, location_specific: v }))}
                            placeholder="Stbd drawer"
                        />
                    </div>

                    {/* Notes */}
                    <FormField
                        label="Notes"
                        value={newItem.description}
                        onChange={(v) => setNewItem((prev) => ({ ...prev, description: v }))}
                        placeholder="Part no, batch"
                    />

                    {/* Expiry / Service — full width */}
                    <FormField
                        label="Expiry / service"
                        type="date"
                        value={newItem.expiry_date}
                        onChange={(v) => setNewItem((prev) => ({ ...prev, expiry_date: v }))}
                    />
                </div>

                {/* Actions */}
                <div className="flex gap-3 mt-3">
                    <button
                        aria-label="Cancel adding item"
                        onClick={onClose}
                        className="flex-1 min-h-[44px] py-2.5 bg-white/5 text-gray-300 rounded-xl text-sm font-bold"
                    >
                        Cancel
                    </button>
                    <Button
                        variant="primary"
                        onClick={handleSaveNew}
                        disabled={!newItem.item_name.trim() || saving}
                        className="flex-1"
                    >
                        {saving ? 'Adding…' : 'Add item'}
                    </Button>
                </div>
            </ModalSheet>
        );
    }

    // ── A scanned code already in Stores: its count, to change (131-B13) ──
    const adjust = async (delta: number) => {
        const updated = await onAdjust(found.id, delta);
        if (updated) setFound(updated);
    };
    return (
        <ModalSheet isOpen={true} onClose={onClose} title={found.item_name} zIndex="z-2000">
            <p className="text-xs font-bold text-emerald-400">Already in Ship&apos;s Stores: change the count here.</p>
            <div className="flex items-start justify-between gap-3 mt-2">
                <div className="flex-1 min-w-0">
                    <p className="text-label font-bold text-sky-400 uppercase tracking-widest">{found.category}</p>
                    {found.location_zone && (
                        <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                            <MapPinIcon className="w-3.5 h-3.5 shrink-0" />
                            <span>
                                {found.location_zone}
                                {found.location_specific ? ` — ${found.location_specific}` : ''}
                            </span>
                        </p>
                    )}
                </div>
                {found.barcode && (
                    <span className="text-label font-mono text-gray-400 bg-white/5 px-2 py-1 rounded-lg">
                        {found.barcode}
                    </span>
                )}
            </div>

            {/* The page's ± path: a delta, so the crew's counts made meanwhile add up */}
            <div className="flex items-center justify-center gap-6 py-4 my-4 bg-white/3 border border-white/6 rounded-2xl">
                <button
                    aria-label={`Take one ${found.item_name}`}
                    onClick={() => void adjust(-1)}
                    disabled={found.quantity <= 0}
                    className="w-14 h-14 rounded-2xl bg-red-500/20 border border-red-500/30 flex items-center justify-center text-red-400 text-2xl font-black hover:bg-red-500/30 transition-all active:scale-90 disabled:opacity-30"
                >
                    −
                </button>
                <div className="text-center">
                    <p
                        role="status"
                        aria-label={`${found.item_name}: ${found.quantity}`}
                        className="text-4xl font-black text-white tabular-nums"
                    >
                        {found.quantity}
                    </p>
                    <p className="text-label text-gray-400 uppercase tracking-widest">In stock</p>
                </div>
                <button
                    aria-label={`Add one ${found.item_name}`}
                    onClick={() => void adjust(1)}
                    className="w-14 h-14 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 text-2xl font-black hover:bg-emerald-500/30 transition-all active:scale-90"
                >
                    +
                </button>
            </div>

            {isLowStock(found) && (
                <p className="flex items-center gap-1.5 p-3 mb-4 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs font-bold text-amber-400">
                    <AlertTriangleIcon className="w-3.5 h-3.5 shrink-0" />
                    <span>Low stock: the minimum is {found.min_quantity}</span>
                </p>
            )}

            <Button variant="primary" onClick={onClose} className="w-full">
                Done
            </Button>
        </ModalSheet>
    );
};
