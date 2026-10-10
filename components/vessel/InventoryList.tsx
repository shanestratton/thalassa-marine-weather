/**
 * InventoryList — Search & management view for ship's inventory.
 *
 * Sub-components extracted to ./inventory/:
 *   - SwipeableInventoryCard: swipeable card with quantity controls and expiry status
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('InventoryList');
import type { InventoryItem, InventoryCategory, StoresBox } from '../../types';
import { INVENTORY_CATEGORIES as CATEGORIES } from '../../types';
import { storesCategoryIcon } from './inventory/categoryIcons';
import { StoresCategoryGrid } from './inventory/StoresCategoryGrid';
import { LocalInventoryService as InventoryService } from '../../services/vessel/LocalInventoryService';
import { inventoryStats } from '../../services/vessel/inventoryStats';
import { InventoryScanner } from './InventoryScanner';
import { downloadInventoryPdf, shareInventoryPdf } from '../../utils/inventoryPdfExport';
import { triggerHaptic } from '../../utils/system';
import { TapToAction } from '../ui/TapToAction';
import { Capacitor } from '@capacitor/core';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { LoadErrorState } from '../ui/LoadErrorState';
import { ShimmerBlock } from '../ui/ShimmerBlock';
import { OfflineBadge } from '../ui/OfflineBadge';
import { UndoToast } from '../ui/UndoToast';
import { FormField } from '../ui/FormField';
import { ModalSheet } from '../ui/ModalSheet';
import { Button } from '../ui/Button';
import { toast } from '../Toast';
import { SwipeableInventoryCard } from './inventory/SwipeableInventoryCard';
import { useRealtimeSync } from '../../hooks/useRealtimeSync';
import { useUndoDelete } from '../../hooks/useUndoDelete';
import { useBinderSource } from '../../hooks/useBinderSource';
import { SharedBinderLine, bringingInCopy } from './SharedBinderLine';
import { useSuccessFlash } from '../../hooks/useSuccessFlash';
import { changedFields, countDelta, REMOVED_NOTHING_SAVED } from '../../utils/changedFields';
import { scrollInputAboveKeyboard } from '../../utils/keyboardScroll';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { initLocalDatabase } from '../../services/vessel/LocalDatabase';
import { StoresBoxService, serverHasBoxes } from '../../services/vessel/StoresBoxService';
import { addRestock, restockFor } from '../../services/vessel/storesRestock';
import { StoresBoxes, type BoxView } from './inventory/BoxesSheet';
import { openBox, registerBoxOpener } from './inventory/openBox';
import { OPEN_BOX_EVENT, consumePendingBox } from '../../services/boxLinks';
import { scanBoxTag } from '../../services/native/nfcTags';
import { useNfcTags } from './inventory/useNfcTags';

interface InventoryListProps {
    onBack: () => void;
}

interface ScopedInventoryData {
    identity: AuthIdentityScope;
    items: InventoryItem[];
    /** Its boxes (126-11a): none until the server has stores_boxes. */
    boxes: StoresBox[];
    /** False until this account's first load lands: the header says 'Loading…'. */
    loaded: boolean;
}

// SwipeableInventoryCard now in ./inventory/SwipeableInventoryCard.tsx

/** Boxes and Scan box, beside the search field. */
const ROW_BUTTON =
    'shrink-0 min-h-[44px] px-3 rounded-xl bg-white/5 border border-white/10 text-sm font-bold text-gray-300';

export const InventoryList: React.FC<InventoryListProps> = ({ onBack }) => {
    const [inventoryData, setInventoryData] = useState<ScopedInventoryData>(() => ({
        identity: getAuthIdentityScope(),
        items: [],
        boxes: [],
        loaded: false,
    }));
    const inventoryDataIsCurrent = isAuthIdentityScopeCurrent(inventoryData.identity);
    // Soft delete with undo (126-B10a): a deleted item stays in state, hidden,
    // until its delete is committed, so no reload brings it back and Undo
    // returns it once, in its place.
    const undoDelete = useUndoDelete<InventoryItem>({
        rows: inventoryData.items,
        commit: (item) => InventoryService.delete(item.id),
        // Declared below; called only once a delete has landed.
        onCommitted: () => reloadInBackground(),
        onCommitFailed: () => toast.error('Failed to delete item'),
        onRestored: () => toast.success('Item restored'),
        describe: (item) => `"${item.item_name}" deleted`,
    });
    const { hiddenIds } = undoDelete;
    // Keyed per item: a second delete gets a fresh toast, countdown and bar.
    const { key: undoToastKey, ...undoToastProps } = undoDelete.toastProps;
    const items = useMemo(() => {
        if (!inventoryDataIsCurrent) return [];
        return hiddenIds.size > 0 ? inventoryData.items.filter((item) => !hiddenIds.has(item.id)) : inventoryData.items;
    }, [inventoryData.items, inventoryDataIsCurrent, hiddenIds]);
    // The header counts what is on screen, so an item waiting out its undo
    // window drops out of '3 items' with its row.
    const stats = useMemo(
        () => (inventoryDataIsCurrent && inventoryData.loaded ? inventoryStats(items) : null),
        [inventoryDataIsCurrent, inventoryData.loaded, items],
    );
    const [loading, setLoading] = useState(true);
    // Distinct from "no items": a failed fetch used to fall straight through to
    // the empty state, so a network error read as "you have no stores".
    const [loadError, setLoadError] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [showScanner, setShowScanner] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const vesselName = useSettingsStore((state) => state.settings.vessel?.name?.trim() || undefined);

    // Header 3-dot menu
    const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
    const headerMenuRef = useRef<HTMLDivElement>(null);
    const loadRequestRef = useRef(0);

    // Category export picker
    const [showExportPicker, setShowExportPicker] = useState(false);
    const [exportCategories, setExportCategories] = useState<Set<InventoryCategory>>(new Set());
    const [exportMode, setExportMode] = useState<'download' | 'share'>('download');

    // ── Load data ──
    const loadItems = useCallback(async (identity: AuthIdentityScope = getAuthIdentityScope(), background = false) => {
        if (!isAuthIdentityScopeCurrent(identity)) return;
        const requestId = ++loadRequestRef.current;
        const isCurrentRequest = () => requestId === loadRequestRef.current && isAuthIdentityScopeCurrent(identity);
        // A background reload (a change from another device, a sync) keeps
        // the list on screen: the shimmer would collapse it and lose the
        // reader's scroll position every time the other device saved.
        if (!background) setLoading(true);
        try {
            // Auth scope changes before LocalDatabase starts its asynchronous
            // file switch. Join that exact switch before any synchronous read,
            // otherwise B could momentarily receive A's still-mounted cache.
            await initLocalDatabase(identity.userId);
            if (!isCurrentRequest()) return;
            // Deduplication is a per-account migration. A global marker allowed
            // the first signed-in sailor to suppress it for every later one.
            const dedupKey = authScopedStorageKey('thalassa_inventory_deduped', identity);
            if (!localStorage.getItem(dedupKey)) {
                await InventoryService.deduplicateByName();
                if (!isCurrentRequest()) return;
                localStorage.setItem(dedupKey, '1');
            }
            setLoadError(false);
            const data = await InventoryService.getAll();
            if (!isCurrentRequest()) return;
            setInventoryData({ identity, items: data, boxes: StoresBoxService.list(), loaded: true });
        } catch (e) {
            log.warn(' load failed:', e);
            if (isCurrentRequest()) {
                setLoadError(true);
                toast.error('Failed to load stores');
            }
        } finally {
            if (isCurrentRequest()) setLoading(false);
        }
    }, []);

    const reloadInBackground = useCallback(() => void loadItems(getAuthIdentityScope(), true), [loadItems]);

    useEffect(() => {
        loadItems();
    }, [loadItems]);

    // Live across devices: a change saved on another device (or by crew on a
    // shared binder) lands here within seconds. RLS decides which rows the
    // socket delivers; the binder read decides which of them this page shows.
    useRealtimeSync('inventory_items', reloadInBackground);

    // Whose stores these are (shared binders, 2026-10-02): the skipper's while
    // this sailor is crew on a boat that shares Ship's Stores. Nobody deletes
    // from a skipper's stores, and a view-only share hides every edit.
    const { source: binder, fetchingSkipperBinder } = useBinderSource('stores', {
        reload: reloadInBackground,
        // Every row this account holds, a hidden one included.
        rowCount: inventoryDataIsCurrent ? inventoryData.items.length : 0,
    });
    const sharedBinder = binder.mode === 'shared';
    const viewOnly = binder.mode === 'shared' && !binder.canWrite;

    // Boxes (126-11a): written only once this phone has read stores_boxes from
    // the server, and opened by id through openBox() (126-11b's tag link).
    const boxesLive = inventoryDataIsCurrent && serverHasBoxes(inventoryData.identity);
    const boxes = boxesLive ? inventoryData.boxes : [];
    const [boxView, setBoxView] = useState<BoxView>(null);
    /** "New item here": the Add form opens in this box. */
    const [scanBox, setScanBox] = useState<string | null>(null);
    useEffect(() => registerBoxOpener((id) => setBoxView({ id })), []);
    // A box from its tag (126-11b): the link that opened Stores, or one that
    // arrives while it is open. Only this account's (services/boxLinks).
    useEffect(() => {
        const take = () => {
            const id = consumePendingBox();
            if (id) openBox(id);
        };
        take();
        window.addEventListener(OPEN_BOX_EVENT, take);
        return () => window.removeEventListener(OPEN_BOX_EVENT, take);
    }, []);
    const nfc = useNfcTags();
    /** Scan box: read the tag held to the iPhone and open its box. */
    const scanTag = async () => {
        const identity = getAuthIdentityScope();
        const { id, words } = await scanBoxTag();
        if (!isAuthIdentityScopeCurrent(identity)) return;
        if (id) openBox(id);
        else if (words) toast.error(words);
    };
    // Its own channel: before the push the table is not published, and a
    // binding the server refuses must not take the items' channel with it.
    useRealtimeSync('stores_boxes', reloadInBackground, boxesLive);

    const { ref: listRef, flash } = useSuccessFlash();

    // ── Filtered + grouped items ──
    const filtered = useMemo(() => {
        let result = [...items];

        // Search filter (client-side for instant response)
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            result = result.filter(
                (i) =>
                    i.item_name.toLowerCase().includes(q) ||
                    (i.location_zone || '').toLowerCase().includes(q) ||
                    (i.location_specific || '').toLowerCase().includes(q) ||
                    (i.description || '').toLowerCase().includes(q) ||
                    (i.barcode || '').toLowerCase().includes(q),
            );
        }

        // Sort by category order then alphabetically
        return result.sort((a, b) => {
            const catA = CATEGORIES.indexOf(a.category);
            const catB = CATEGORIES.indexOf(b.category);
            if (catA !== catB) return catA - catB;
            return a.item_name.localeCompare(b.item_name);
        });
    }, [items, searchQuery]);

    // ── Export/Share by category (PDF) ──
    const handleExport = useCallback(
        async (
            mode: 'download' | 'share',
            categories: Set<InventoryCategory>,
            identity: AuthIdentityScope = getAuthIdentityScope(),
        ) => {
            if (!isAuthIdentityScopeCurrent(identity)) return;
            const exportItems = items.map((item) => ({ ...item }));
            const exportCategorySnapshot = new Set(categories);
            try {
                const opts = {
                    items: exportItems,
                    categories: exportCategorySnapshot,
                    vesselName,
                };
                if (mode === 'share') {
                    await shareInventoryPdf(opts);
                } else {
                    await downloadInventoryPdf(opts);
                    if (!isAuthIdentityScopeCurrent(identity)) return;
                    toast.success('Stores PDF downloaded');
                }
            } catch (e) {
                log.warn(' Export failed:', e);
                if (isAuthIdentityScopeCurrent(identity)) toast.error('Export failed');
            }
            if (!isAuthIdentityScopeCurrent(identity)) return;
            setShowExportPicker(false);
            setExportCategories(new Set());
        },
        [items, vesselName],
    );

    const toggleExportCategory = useCallback((cat: InventoryCategory) => {
        setExportCategories((prev) => {
            const next = new Set(prev);
            if (next.has(cat)) next.delete(cat);
            else next.add(cat);
            return next;
        });
    }, []);

    // Group by category for rendering
    const groupedItems = useMemo(
        () =>
            CATEGORIES.map((cat) => ({ category: cat, items: filtered.filter((i) => i.category === cat) })).filter(
                (g) => g.items.length > 0,
            ),
        [filtered],
    );

    // ── Soft-delete with undo (useUndoDelete above) ──
    const handleDelete = (id: string, identity: AuthIdentityScope = getAuthIdentityScope()) => {
        const item = items.find((i) => i.id === id);
        if (!item || !isAuthIdentityScopeCurrent(identity)) return;
        triggerHaptic('medium');
        setExpandedId(null);
        undoDelete.remove(item);
    };

    // ── Edit item ──
    const [editItem, setEditItem] = useState<{ identity: AuthIdentityScope; item: InventoryItem } | null>(null);
    const [editName, setEditName] = useState('');
    const [editCategory, setEditCategory] = useState<InventoryCategory>('Provisions');
    const [editQty, setEditQty] = useState(1);
    const [editMinQty, setEditMinQty] = useState(0);
    const [editZone, setEditZone] = useState('');
    const [editSpecific, setEditSpecific] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [editExpiry, setEditExpiry] = useState('');
    const [editBarcode, setEditBarcode] = useState('');
    const [editBoxId, setEditBoxId] = useState('');
    // One Save at a time: a count edit is a delta, so a second tap while the
    // first is still writing would take the count twice.
    const savingEditRef = useRef(false);
    const [savingEdit, setSavingEdit] = useState(false);

    useEffect(
        () =>
            subscribeAuthIdentityScope((next) => {
                setInventoryData({ identity: next, items: [], boxes: [], loaded: false });
                setBoxView(null);
                setScanBox(null);
                setEditBoxId('');
                setLoading(true);
                setSearchQuery('');
                setShowScanner(false);
                setExpandedId(null);
                setHeaderMenuOpen(false);
                setShowExportPicker(false);
                setExportCategories(new Set());
                setExportMode('download');
                setEditItem(null);
                setEditName('');
                setEditCategory('Provisions');
                setEditQty(1);
                setEditMinQty(0);
                setEditZone('');
                setEditSpecific('');
                setEditDescription('');
                setEditExpiry('');
                setEditBarcode('');
                void loadItems(next);
            }),
        [loadItems],
    );

    const openEdit = (item: InventoryItem, identity: AuthIdentityScope = getAuthIdentityScope()) => {
        if (!isAuthIdentityScopeCurrent(identity)) return;
        setEditItem({ identity, item });
        setEditName(item.item_name);
        setEditCategory(item.category);
        setEditQty(item.quantity);
        setEditMinQty(item.min_quantity);
        setEditZone(item.location_zone || '');
        setEditSpecific(item.location_specific || '');
        setEditDescription(item.description || '');
        setEditExpiry(item.expiry_date || '');
        setEditBarcode(item.barcode || '');
        setEditBoxId(boxOf(item));
    };

    /** The item's box, if this phone knows it ('' otherwise: "not in a box"). */
    const boxOf = (item: InventoryItem) => (boxes.some((box) => box.id === item.box_id) ? item.box_id! : '');
    /**
     * Zone or Specific typed by hand takes the item out of its box (the Box
     * field below says "Not in a box"): an item in a box is at the box's
     * place, and the box's next rename would write over the typed text.
     */
    const place = (set: (value: string) => void) => (value: string) => {
        set(value);
        setEditBoxId('');
    };
    /** A box picked in the Edit sheet: its zone and name become the item's place, for older builds. */
    const pickBox = (id: string) => {
        setEditBoxId(id);
        const box = boxes.find((candidate) => candidate.id === id);
        if (box) {
            setEditZone(box.location_zone ?? '');
            setEditSpecific(box.name);
        }
    };

    const handleSaveEdit = async () => {
        if (!editItem || !editName.trim() || savingEditRef.current) return;
        const { identity, item } = editItem;
        if (!isAuthIdentityScopeCurrent(identity)) return;
        const itemId = item.id;
        // Only what was changed against the item as the sheet opened, so the
        // crew's ± and the Galley's deductions made meanwhile survive. A count
        // edit is a delta against that count ("took 2", not "set to 10"), on
        // the same delta path as ±, so changes made at once add up (STORES-04).
        const delta = countDelta(item.quantity, editQty);
        const updates = changedFields(item, {
            item_name: editName,
            category: editCategory,
            min_quantity: editMinQty,
            barcode: editBarcode || null,
            location_zone: editZone || null,
            location_specific: editSpecific || null,
            description: editDescription || null,
            expiry_date: editExpiry || null,
        });
        if (editBoxId !== boxOf(item)) updates.box_id = editBoxId || null;
        const changed = Object.keys(updates).length > 0;
        if (!delta && !changed) {
            setEditItem(null);
            return;
        }
        const put = (saved: InventoryItem) =>
            setInventoryData((previous) =>
                previous.identity.key === identity.key && previous.identity.generation === identity.generation
                    ? {
                          ...previous,
                          items: previous.items.map((row) => (row.id === itemId ? saved : row)),
                      }
                    : previous,
            );
        savingEditRef.current = true;
        setSavingEdit(true);
        try {
            // Either write returns null when the row was gone (deleted elsewhere).
            let updated = delta ? await InventoryService.adjustQuantity(itemId, delta) : item;
            if (!isAuthIdentityScopeCurrent(identity)) return;
            if (updated && delta) {
                // The count has moved. The sheet now starts from the count it
                // set, so a retry after the write below fails takes nothing
                // twice; only the count, so other fields still diff against
                // the item as it opened.
                put(updated);
                setEditItem({ identity, item: { ...item, quantity: editQty } });
            }
            if (updated && changed) updated = await InventoryService.update(itemId, updates);
            if (!isAuthIdentityScopeCurrent(identity)) return;
            setEditItem(null);
            if (!updated) {
                toast.error(REMOVED_NOTHING_SAVED);
                reloadInBackground();
                return;
            }
            put(updated);
            triggerHaptic('medium');
            toast.success('Item updated');
            flash();
        } catch (e) {
            log.warn(' edit failed:', e);
            if (isAuthIdentityScopeCurrent(identity)) toast.error('Failed to update item');
        } finally {
            savingEditRef.current = false;
            setSavingEdit(false);
        }
    };

    // ── Quick quantity adjustment ──
    // One at a time, so each − reads the count the last one left: a quick
    // double tap on the last spare puts it on the shopping list once.
    const adjustQueueRef = useRef<Promise<void>>(Promise.resolve());
    const handleQuantityAdjust = (id: string, delta: number, identity: AuthIdentityScope = getAuthIdentityScope()) => {
        if (!isAuthIdentityScopeCurrent(identity)) return;
        triggerHaptic('light');
        adjustQueueRef.current = adjustQueueRef.current.then(() => adjustQuantityNow(id, delta, identity));
    };
    const adjustQuantityNow = async (id: string, delta: number, identity: AuthIdentityScope) => {
        if (!isAuthIdentityScopeCurrent(identity)) return;
        try {
            // Low stock goes on the shopping list (126-11a): own Stores only.
            const before = delta < 0 ? InventoryService.getItem(id) : null;
            const updated = await InventoryService.adjustQuantity(id, delta);
            if (!isAuthIdentityScopeCurrent(identity)) return;
            const restock = before && updated ? restockFor(before, updated) : null;
            if (updated && restock) {
                void addRestock(updated, restock)
                    .then((line) => line && isAuthIdentityScopeCurrent(identity) && toast.success(line))
                    .catch((e) => {
                        log.warn(' restock failed:', e);
                        toast.error("Couldn't add it to the shopping list");
                    });
            }
            if (updated) {
                setInventoryData((previous) =>
                    previous.identity.key === identity.key && previous.identity.generation === identity.generation
                        ? {
                              ...previous,
                              items: previous.items.map((item) => (item.id === id ? updated : item)),
                          }
                        : previous,
                );
            }
        } catch (e) {
            log.warn(' qty adjust failed:', e);
            if (isAuthIdentityScopeCurrent(identity)) toast.error('Failed to update quantity');
        }
    };

    if (showScanner && inventoryDataIsCurrent && !viewOnly) {
        const scannerIdentity = inventoryData.identity;
        return (
            <InventoryScanner
                onClose={() => {
                    if (!isAuthIdentityScopeCurrent(scannerIdentity)) return;
                    setShowScanner(false);
                    setScanBox(null);
                }}
                onItemSaved={() => {
                    void loadItems(scannerIdentity);
                }}
                startInManualMode
                box={boxes.find((box) => box.id === scanBox)}
            />
        );
    }

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Ship's Stores"
                    onBack={onBack}
                    breadcrumbs={['Boat Binder', "Ship's Stores"]}
                    status={
                        <>
                            <OfflineBadge />
                            <SharedBinderLine register="stores" source={binder} />
                        </>
                    }
                    subtitle={
                        // One count while the stores are empty: '0 items · 0 units'
                        // said the zero twice (UX scorecard run 7).
                        <p className="text-label text-gray-400 font-bold uppercase tracking-widest">
                            {stats
                                ? stats.totalItems === 0
                                    ? '0 items'
                                    : `${stats.totalItems} ${stats.totalItems === 1 ? 'item' : 'items'} · ${Math.round(stats.totalQuantity * 10) / 10} ${Math.round(stats.totalQuantity * 10) / 10 === 1 ? 'unit' : 'units'}`
                                : 'Loading…'}
                            {stats && stats.lowStock > 0 && (
                                <span className="text-amber-400"> · {stats.lowStock} low</span>
                            )}
                        </p>
                    }
                    action={
                        <div className="relative" ref={headerMenuRef}>
                            <button
                                onClick={() => setHeaderMenuOpen(!headerMenuOpen)}
                                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                                aria-label="Page actions"
                            >
                                <svg
                                    aria-hidden="true"
                                    className="w-5 h-5 text-gray-400"
                                    viewBox="0 0 24 24"
                                    fill="currentColor"
                                >
                                    <circle cx="12" cy="5" r="1.5" />
                                    <circle cx="12" cy="12" r="1.5" />
                                    <circle cx="12" cy="19" r="1.5" />
                                </svg>
                            </button>
                            {headerMenuOpen && (
                                <>
                                    <div className="fixed inset-0 z-40" onClick={() => setHeaderMenuOpen(false)} />
                                    <div className="absolute right-0 top-full mt-1 z-50 w-52 bg-slate-800 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
                                        <button
                                            aria-label="Download inventory as PDF"
                                            disabled={items.length === 0}
                                            onClick={() => {
                                                setHeaderMenuOpen(false);
                                                setExportMode('download');
                                                setExportCategories(new Set());
                                                setShowExportPicker(true);
                                            }}
                                            className="w-full flex items-center gap-2.5 px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors disabled:opacity-30"
                                        >
                                            <svg
                                                className="w-4 h-4 text-sky-400"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                                                />
                                            </svg>
                                            Download stores list
                                        </button>
                                        <div className="border-t border-white/5" />
                                        <button
                                            aria-label="Share stores list via email or AirDrop"
                                            disabled={items.length === 0}
                                            onClick={() => {
                                                setHeaderMenuOpen(false);
                                                setExportMode('share');
                                                setExportCategories(new Set());
                                                setShowExportPicker(true);
                                            }}
                                            className="w-full flex items-center gap-2.5 px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors disabled:opacity-30"
                                        >
                                            <svg
                                                className="w-4 h-4 text-emerald-400"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"
                                                />
                                            </svg>
                                            Share stores list
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    }
                />

                {/* ── Search ── only once there is something to search: a live
                    field over an empty list offered nothing (UX scorecard run 7).
                    Boxes as soon as the page has loaded, so boxes can be set up
                    before anything is in Stores (126-11a). */}
                {inventoryDataIsCurrent && inventoryData.loaded && (
                    <div className="shrink-0 px-4 pb-3 flex justify-end gap-2">
                        {(items.length > 0 || searchQuery) && (
                            <input
                                type="text"
                                aria-label="Search stores"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                // Shorter beside Scan box, so it is not cut off on a 320-390 pt iPhone.
                                placeholder={nfc ? 'Search…' : 'Search by name or location…'}
                                className="min-w-0 flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-400 [.display-light_&]:placeholder-slate-600! outline-hidden focus:border-sky-500/30"
                            />
                        )}
                        {/* Boxes in a locker (126-11a): see what is in each. */}
                        <button onClick={() => setBoxView({ id: null })} className={ROW_BUTTON}>
                            Boxes
                        </button>
                        {nfc && (
                            <button onClick={() => void scanTag()} className={ROW_BUTTON}>
                                Scan box
                            </button>
                        )}
                    </div>
                )}

                {/* ── Item List (scrollable, stops above CTA) ── */}
                <div ref={listRef} className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-3 no-scrollbar">
                    {loading ? (
                        <div className="space-y-3 px-1">
                            <ShimmerBlock variant="list" rows={4} />
                        </div>
                    ) : loadError ? (
                        <LoadErrorState what="your stores" onRetry={loadItems} />
                    ) : fetchingSkipperBinder && !searchQuery ? (
                        <p role="status" className="py-16 text-center text-sm font-semibold text-gray-400">
                            {bringingInCopy(binder)}
                        </p>
                    ) : groupedItems.length === 0 ? (
                        <EmptyState
                            icon={
                                <svg
                                    className="w-8 h-8"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={1.5}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
                                    />
                                </svg>
                            }
                            title={searchQuery ? 'No matches' : 'Nothing in stores yet'}
                            subtitle={
                                // Add item opens the scanner, which also takes an item by hand —
                                // one path, not two (UX scorecard run 6).
                                searchQuery
                                    ? 'Try a different search term.'
                                    : viewOnly
                                      ? "Nothing in the skipper's stores yet."
                                      : 'Spares, provisions and consumables, and where each is stowed. Tap Add item below, then scan its barcode or type it in.'
                            }
                            className="py-16"
                        />
                    ) : (
                        groupedItems.map((group) => {
                            const CategoryIcon = storesCategoryIcon(group.category);
                            return (
                                <div key={group.category}>
                                    <div className="flex items-center gap-2 mb-2 mt-1">
                                        <CategoryIcon className="h-4 w-4 shrink-0 text-gray-400" />
                                        <span className="text-label font-black text-gray-400 uppercase tracking-widest">
                                            {group.category}
                                        </span>
                                        <span className="text-micro text-gray-400 font-bold">
                                            ({group.items.length})
                                        </span>
                                    </div>
                                    <div className="space-y-2">
                                        {group.items.map((item) => (
                                            <SwipeableInventoryCard
                                                key={item.id}
                                                item={item}
                                                isExpanded={expandedId === item.id}
                                                onTap={() => setExpandedId(expandedId === item.id ? null : item.id)}
                                                onDelete={
                                                    sharedBinder
                                                        ? undefined
                                                        : () => handleDelete(item.id, inventoryData.identity)
                                                }
                                                onEdit={
                                                    viewOnly ? undefined : () => openEdit(item, inventoryData.identity)
                                                }
                                                onQuantityAdjust={
                                                    viewOnly
                                                        ? undefined
                                                        : (id, delta) =>
                                                              handleQuantityAdjust(id, delta, inventoryData.identity)
                                                }
                                            />
                                        ))}
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>

                {/* ── Add CTA (8px above menu bar) ── */}
                <div
                    className="shrink-0 px-4 pt-2 bg-slate-950"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                >
                    {/* A view-only share has no Add (and so no Scan): the
                        skipper's stores are theirs to stock. */}
                    {!viewOnly && (
                        <TapToAction
                            label="Add item"
                            icon={
                                <svg
                                    className="w-4 h-4"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2.5}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                                </svg>
                            }
                            onConfirm={() => {
                                triggerHaptic('medium');
                                // The scanner finds rows by barcode, a hidden
                                // one too: a delete waiting out its undo is
                                // made now, not restocked and then deleted.
                                undoDelete.commitNow();
                                setShowScanner(true);
                            }}
                            theme="emerald"
                        />
                    )}
                </div>
            </div>

            {/* ═══ EDIT ITEM MODAL ═══ */}
            {editItem && (
                <ModalSheet isOpen={true} onClose={() => setEditItem(null)} title="Edit item">
                    <div className="space-y-2">
                        {/* Category — first */}
                        <div>
                            <label className="text-label font-bold text-gray-400 uppercase tracking-widest">
                                Category
                            </label>
                            <StoresCategoryGrid value={editCategory} onChange={setEditCategory} />
                        </div>

                        {/* Name */}
                        <div>
                            <FormField
                                label="Item name"
                                value={editName}
                                onChange={setEditName}
                                required
                                error={!editName.trim() && editName !== '' ? 'Item name is required' : undefined}
                            />
                        </div>

                        {/* Barcode */}
                        <div>
                            <label className="text-label font-bold text-gray-400 uppercase tracking-widest">
                                Barcode
                            </label>
                            <div className="flex gap-1.5 mt-0.5">
                                <input
                                    type="text"
                                    value={editBarcode}
                                    onChange={(e) => setEditBarcode(e.target.value)}
                                    onFocus={scrollInputAboveKeyboard}
                                    className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-1.5 text-white text-sm font-mono outline-hidden focus:border-sky-500 transition-colors"
                                />
                                <button
                                    aria-label="Scan barcode with camera"
                                    type="button"
                                    onClick={async () => {
                                        const identity = editItem.identity;
                                        if (!isAuthIdentityScopeCurrent(identity)) return;
                                        if (Capacitor.isNativePlatform()) {
                                            try {
                                                const { BarcodeScanner, BarcodeFormat } =
                                                    await import('../../services/native/dataScanner');
                                                if (!isAuthIdentityScopeCurrent(identity)) return;
                                                const { camera } = await BarcodeScanner.checkPermissions();
                                                if (!isAuthIdentityScopeCurrent(identity)) return;
                                                if (camera !== 'granted') {
                                                    const r = await BarcodeScanner.requestPermissions();
                                                    if (r.camera !== 'granted' || !isAuthIdentityScopeCurrent(identity))
                                                        return;
                                                }
                                                const { barcodes } = await BarcodeScanner.scan({
                                                    formats: [
                                                        BarcodeFormat.Ean13,
                                                        BarcodeFormat.Ean8,
                                                        BarcodeFormat.UpcA,
                                                        BarcodeFormat.UpcE,
                                                        BarcodeFormat.Code128,
                                                        BarcodeFormat.Code39,
                                                        BarcodeFormat.QrCode,
                                                    ],
                                                });
                                                if (!isAuthIdentityScopeCurrent(identity)) return;
                                                if (barcodes.length > 0 && barcodes[0].rawValue) {
                                                    setEditBarcode(barcodes[0].rawValue);
                                                    triggerHaptic('medium');
                                                }
                                            } catch (e) {
                                                log.warn(' cancelled:', e);
                                            }
                                        }
                                    }}
                                    className="px-3 flex items-center justify-center bg-sky-600/20 border border-sky-500/30 rounded-xl text-sky-400 hover:bg-sky-600/30 transition-colors active:scale-95"
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
                                </button>
                            </div>
                        </div>

                        {/* Quantity + Min */}
                        <div className="grid grid-cols-2 gap-2">
                            <FormField
                                label="Quantity"
                                type="number"
                                value={editQty}
                                onChange={(v) => setEditQty(Math.max(0, parseInt(v) || 0))}
                                min={0}
                            />
                            <FormField
                                label="Min qty"
                                type="number"
                                value={editMinQty}
                                onChange={(v) => setEditMinQty(Math.max(0, parseInt(v) || 0))}
                                min={0}
                            />
                        </div>

                        {/* Location */}
                        <div className="grid grid-cols-2 gap-2">
                            <FormField
                                label="Zone"
                                value={editZone}
                                onChange={place(setEditZone)}
                                placeholder="Engine room"
                            />
                            <FormField
                                label="Specific"
                                value={editSpecific}
                                onChange={place(setEditSpecific)}
                                placeholder="Port locker"
                            />
                        </div>

                        {/* Box (126-11a): putting it in one writes the box's zone and name above. */}
                        {boxes.length > 0 && (
                            <label className="block">
                                <span className="ui-field-label text-label font-bold text-gray-300 uppercase tracking-widest">
                                    Box
                                </span>
                                <select
                                    value={editBoxId}
                                    onChange={(e) => pickBox(e.target.value)}
                                    className="w-full min-h-[44px] mt-0.5 bg-white/5 border border-white/10 rounded-xl px-3 text-sm text-white"
                                >
                                    <option value="">Not in a box</option>
                                    {boxes.map((box) => (
                                        <option key={box.id} value={box.id}>
                                            {box.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}

                        {/* Notes */}
                        <FormField
                            label="Notes"
                            value={editDescription}
                            onChange={setEditDescription}
                            placeholder="Part no, batch"
                        />

                        {/* Expiry — full width to prevent date picker overflow */}
                        <FormField label="Expiry / service" type="date" value={editExpiry} onChange={setEditExpiry} />
                    </div>

                    {!editName.trim() && (
                        <p className="text-micro text-amber-400/80 text-center mt-2">Item name is required</p>
                    )}
                    <Button
                        variant="primary"
                        aria-label="Save inventory item changes"
                        onClick={handleSaveEdit}
                        disabled={!editName.trim() || savingEdit}
                        className="w-full mt-2 disabled:cursor-not-allowed"
                    >
                        Save changes
                    </Button>
                </ModalSheet>
            )}

            <UndoToast key={undoToastKey} {...undoToastProps} />

            {/* Boxes (126-11a): one sheet at a time; a new box view starts fresh.
                Shown once the page has loaded, so a box opened from its tag on
                the way in never flashes "not on this phone" first (126-11b). */}
            <StoresBoxes
                key={boxView ? (boxView.id ?? '') : '-'}
                view={inventoryDataIsCurrent && inventoryData.loaded ? boxView : null}
                setView={setBoxView}
                items={items}
                boxes={boxes}
                live={boxesLive}
                editable={!viewOnly}
                canDelete={!sharedBinder}
                onAdjust={viewOnly ? undefined : (id, delta) => handleQuantityAdjust(id, delta, inventoryData.identity)}
                onNewItem={(box) => {
                    undoDelete.commitNow();
                    setScanBox(box.id);
                    setShowScanner(true);
                }}
                reload={() => loadItems(getAuthIdentityScope(), true)}
                onScan={nfc ? () => void scanTag() : undefined}
            />

            {/* ═══ EXPORT CATEGORY PICKER ═══ */}
            {showExportPicker && (
                <ModalSheet
                    isOpen={true}
                    onClose={() => setShowExportPicker(false)}
                    title={exportMode === 'share' ? 'Share stores list' : 'Download stores list'}
                >
                    <p className="text-sm text-gray-400 mb-3">Select categories to include, or leave blank for all:</p>
                    <div className="grid grid-cols-2 gap-2 mb-4">
                        {CATEGORIES.map((cat) => {
                            const count = items.filter((i) => i.category === cat).length;
                            const selected = exportCategories.has(cat);
                            const CategoryIcon = storesCategoryIcon(cat);
                            return (
                                <button
                                    aria-label={`${cat}, ${count} ${count === 1 ? 'item' : 'items'}`}
                                    aria-pressed={selected}
                                    key={cat}
                                    onClick={() => toggleExportCategory(cat)}
                                    className={`flex min-h-[44px] items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-bold transition-all ${
                                        selected
                                            ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                                            : 'bg-white/5 text-gray-400 border border-white/5 hover:border-white/10'
                                    }`}
                                >
                                    <CategoryIcon className="h-4 w-4 shrink-0" />
                                    <span className="flex-1 text-left">{cat}</span>
                                    <span className="text-xs text-gray-400">{count}</span>
                                    {selected && (
                                        <svg
                                            className="w-4 h-4 text-sky-400"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={3}
                                        >
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                        </svg>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                    <Button
                        variant="primary"
                        onClick={() => handleExport(exportMode, exportCategories, inventoryData.identity)}
                        className="w-full"
                    >
                        {exportMode === 'share' ? 'Share' : 'Download'}{' '}
                        {exportCategories.size > 0
                            ? `${exportCategories.size} ${exportCategories.size === 1 ? 'category' : 'categories'}`
                            : 'all categories'}
                    </Button>
                </ModalSheet>
            )}
        </div>
    );
};
