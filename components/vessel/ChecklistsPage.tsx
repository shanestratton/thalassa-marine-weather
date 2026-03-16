/**
 * ChecklistsPage — Pre-departure and operational checklists.
 *
 * Features:
 * - Add headings (sections) and detail items
 * - Run checklist with pass/fail/unchecked status
 * - Color-coded results (green=pass, red=fail)
 * - Flag failed items for R&M (creates maintenance task)
 * - Swipe-to-delete
 * - Search
 */
import React, { useState, useEffect, useCallback } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('ChecklistsPage');
import {
    LocalChecklistService,
    type ChecklistEntry,
    type ChecklistRun,
    type ChecklistRunItem,
    type RunItemStatus,
} from '../../services/vessel/LocalChecklistService';
import { LocalMaintenanceService } from '../../services/vessel/LocalMaintenanceService';
import { triggerHaptic } from '../../utils/system';
import { SlideToAction } from '../ui/SlideToAction';
import { PageHeader } from '../ui/PageHeader';
import { toast } from '../Toast';
import { useSwipeable } from '../../hooks/useSwipeable';
import { ModalSheet } from '../ui/ModalSheet';
import { EmptyState } from '../ui/EmptyState';
import { FormField } from '../ui/FormField';
import { generateUUID } from '../../services/vessel/LocalDatabase';

interface ChecklistsPageProps {
    onBack: () => void;
}

// ── SwipeableItemCard ──────────────────────────────────────────

interface SwipeableItemCardProps {
    entry: ChecklistEntry;
    onEdit: () => void;
    onDelete: () => void;
    isHeading?: boolean;
    itemCount?: number;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    isFirst?: boolean;
    isLast?: boolean;
}

const SwipeableItemCard: React.FC<SwipeableItemCardProps> = ({
    entry,
    onEdit,
    onDelete,
    isHeading,
    itemCount,
    onMoveUp,
    onMoveDown,
    isFirst,
    isLast,
}) => {
    const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable();

    return (
        <div className="relative overflow-hidden rounded-xl">
            {/* Delete action */}
            <div
                className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => {
                    resetSwipe();
                    onDelete();
                }}
            >
                <div className="text-center text-white">
                    <svg className="w-4 h-4 mx-auto mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                    </svg>
                    <span className="text-[11px] font-bold">Delete</span>
                </div>
            </div>

            {/* Main card */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} border rounded-xl overflow-hidden bg-white/[0.03] ${
                    isHeading ? 'border-emerald-500/20' : 'border-white/[0.06] ml-4'
                }`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                ref={ref}
                onClick={() => {
                    if (swipeOffset === 0) onEdit();
                }}
            >
                <div className="flex items-center gap-3 p-3">
                    {isHeading ? (
                        <>
                            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
                                <svg
                                    className="w-4 h-4 text-emerald-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={1.5}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
                                    />
                                </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                                <h4 className="text-sm font-black text-white tracking-wide">{entry.text}</h4>
                                <p className="text-[11px] text-emerald-400/70 font-bold uppercase tracking-widest mt-0.5">
                                    {itemCount ?? 0} item{(itemCount ?? 0) !== 1 ? 's' : ''}
                                </p>
                            </div>
                        </>
                    ) : (
                        <>
                            {/* Move up/down buttons */}
                            <div className="flex flex-col gap-0.5 shrink-0">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onMoveUp?.();
                                    }}
                                    disabled={isFirst}
                                    className={`p-1 rounded transition-colors ${isFirst ? 'text-white/10' : 'text-white/40 hover:text-white/70 hover:bg-white/10 active:scale-90'}`}
                                    aria-label="Move up"
                                >
                                    <svg
                                        className="w-3.5 h-3.5"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2.5}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M4.5 15.75l7.5-7.5 7.5 7.5"
                                        />
                                    </svg>
                                </button>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onMoveDown?.();
                                    }}
                                    disabled={isLast}
                                    className={`p-1 rounded transition-colors ${isLast ? 'text-white/10' : 'text-white/40 hover:text-white/70 hover:bg-white/10 active:scale-90'}`}
                                    aria-label="Move down"
                                >
                                    <svg
                                        className="w-3.5 h-3.5"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2.5}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                                        />
                                    </svg>
                                </button>
                            </div>
                            <div className="w-5 h-5 rounded-full border-2 border-white/20 shrink-0" />
                            <span className="text-sm text-white/80 font-medium flex-1 min-w-0 truncate">
                                {entry.text}
                            </span>
                        </>
                    )}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onEdit();
                        }}
                        className="shrink-0 p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                        aria-label="Edit"
                    >
                        <svg
                            className="w-3.5 h-3.5 text-slate-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.5}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"
                            />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
};

// ── Status colors for run mode ─────────────────────────────────

const STATUS_STYLES: Record<RunItemStatus, { bg: string; border: string; icon: string; text: string }> = {
    unchecked: {
        bg: 'bg-white/[0.03]',
        border: 'border-white/[0.08]',
        icon: 'text-gray-400',
        text: 'text-white/60',
    },
    pass: {
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-500/25',
        icon: 'text-emerald-400',
        text: 'text-white',
    },
    fail: {
        bg: 'bg-red-500/10',
        border: 'border-red-500/25',
        icon: 'text-red-400',
        text: 'text-white',
    },
};

// ── Main Component ─────────────────────────────────────────────

export const ChecklistsPage: React.FC<ChecklistsPageProps> = ({ onBack }) => {
    const [entries, setEntries] = useState<ChecklistEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [headerMenuOpen, setHeaderMenuOpen] = useState(false);

    // Add/Edit form state
    const [showForm, setShowForm] = useState(false);
    const [editEntry, setEditEntry] = useState<ChecklistEntry | null>(null);
    const [formType, setFormType] = useState<'heading' | 'detail'>('heading');
    const [formText, setFormText] = useState('');
    const [formHeadingId, setFormHeadingId] = useState<string>('');

    // Run mode state
    const [showRun, setShowRun] = useState(false);
    const [runItems, setRunItems] = useState<ChecklistRunItem[]>([]);
    const [runId, setRunId] = useState('');

    // ── Load ──
    const loadEntries = useCallback(() => {
        setLoading(true);
        try {
            setEntries(LocalChecklistService.getAll());
        } catch (e) {
            log.error('Failed to load checklists:', e);
            toast.error('Failed to load checklists');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadEntries();
    }, [loadEntries]);

    // ── Computed ──
    const headings = entries.filter((e) => e.type === 'heading');
    const grouped = headings.map((h) => ({
        heading: h,
        items: entries.filter((e) => e.type === 'detail' && e.heading_id === h.id).sort((a, b) => a.order - b.order),
    }));

    const filtered = searchQuery.trim()
        ? grouped
              .map((g) => ({
                  ...g,
                  items: g.items.filter((i) => i.text.toLowerCase().includes(searchQuery.toLowerCase())),
              }))
              .filter((g) => g.heading.text.toLowerCase().includes(searchQuery.toLowerCase()) || g.items.length > 0)
        : grouped;

    const totalDetails = entries.filter((e) => e.type === 'detail').length;

    // ── Form handlers ──
    const resetForm = () => {
        setFormText('');
        setFormType('heading');
        setFormHeadingId('');
        setEditEntry(null);
    };

    const openAddForm = () => {
        resetForm();
        // Default to 'detail' if headings exist, otherwise 'heading'
        setFormType(headings.length > 0 ? 'detail' : 'heading');
        if (headings.length > 0) setFormHeadingId(headings[0].id);
        setShowForm(true);
    };

    const openEditForm = (entry: ChecklistEntry) => {
        setEditEntry(entry);
        setFormType(entry.type);
        setFormText(entry.text);
        setFormHeadingId(entry.heading_id || '');
        setShowForm(true);
    };

    const handleSave = useCallback(async () => {
        if (!formText.trim()) return;
        try {
            triggerHaptic('medium');
            if (editEntry) {
                await LocalChecklistService.update(editEntry.id, {
                    text: formText.trim(),
                    heading_id: formType === 'detail' ? formHeadingId : null,
                });
                toast.success('Updated');
                setShowForm(false);
                resetForm();
            } else {
                await LocalChecklistService.create({
                    type: formType,
                    text: formText.trim(),
                    heading_id: formType === 'detail' ? formHeadingId : null,
                });
                toast.success(formType === 'heading' ? 'Section added' : 'Item added');
                // Keep form open — just clear text so user can add more
                setFormText('');
            }
            loadEntries();
        } catch (e) {
            log.error('Failed to save:', e);
            toast.error('Failed to save');
        }
    }, [editEntry, formText, formType, formHeadingId, loadEntries]);

    const handleDelete = useCallback(
        async (id: string) => {
            const entry = entries.find((e) => e.id === id);
            if (!entry) return;

            // Guard: don't delete headings that still have items
            if (entry.type === 'heading') {
                const children = entries.filter((e) => e.type === 'detail' && e.heading_id === id);
                if (children.length > 0) {
                    toast.error('Remove all items from this section first');
                    return;
                }
            }

            triggerHaptic('medium');
            try {
                await LocalChecklistService.delete(id);
                loadEntries();
                const isH = entry.type === 'heading';
                toast.success(isH ? 'Section deleted' : 'Item deleted');
            } catch (e) {
                log.error('Failed to delete:', e);
                toast.error('Failed to delete');
            }
        },
        [entries, loadEntries],
    );

    // ── Reorder items ──
    const handleMoveItem = useCallback(
        async (groupItems: ChecklistEntry[], itemIndex: number, direction: 'up' | 'down') => {
            const targetIndex = direction === 'up' ? itemIndex - 1 : itemIndex + 1;
            if (targetIndex < 0 || targetIndex >= groupItems.length) return;
            triggerHaptic('light');
            const itemA = groupItems[itemIndex];
            const itemB = groupItems[targetIndex];
            // Swap their order values
            try {
                await LocalChecklistService.update(itemA.id, { order: itemB.order });
                await LocalChecklistService.update(itemB.id, { order: itemA.order });
                loadEntries();
            } catch (e) {
                log.error('Failed to reorder:', e);
                toast.error('Failed to reorder');
            }
        },
        [loadEntries],
    );

    // ── Run mode ──
    const startRun = useCallback(() => {
        setHeaderMenuOpen(false);
        const details = entries.filter((e) => e.type === 'detail');
        if (details.length === 0) {
            toast.error('No items to check — add some first');
            return;
        }
        triggerHaptic('medium');
        const items: ChecklistRunItem[] = grouped.flatMap((g) =>
            g.items.map((item) => ({
                entry_id: item.id,
                heading: g.heading.text,
                text: item.text,
                status: 'unchecked' as RunItemStatus,
                flagged_rm: false,
                notes: '',
            })),
        );
        setRunItems(items);
        setRunId(generateUUID());
        setShowRun(true);
    }, [entries, grouped]);

    const toggleRunItem = useCallback((entryId: string) => {
        triggerHaptic('light');
        setRunItems((prev) =>
            prev.map((item) => {
                if (item.entry_id !== entryId) return item;
                // Cycle: unchecked → pass → fail → unchecked
                const next: RunItemStatus =
                    item.status === 'unchecked' ? 'pass' : item.status === 'pass' ? 'fail' : 'unchecked';
                return { ...item, status: next, flagged_rm: next === 'fail' ? item.flagged_rm : false };
            }),
        );
    }, []);

    const toggleRmFlag = useCallback((entryId: string) => {
        triggerHaptic('light');
        setRunItems((prev) =>
            prev.map((item) => {
                if (item.entry_id !== entryId) return item;
                return { ...item, flagged_rm: !item.flagged_rm };
            }),
        );
    }, []);

    const completeRun = useCallback(async () => {
        triggerHaptic('heavy');
        const run: ChecklistRun = {
            id: runId,
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            items: runItems,
        };
        await LocalChecklistService.saveRun(run);

        // Create R&M tasks for flagged items
        const flagged = runItems.filter((i) => i.flagged_rm);
        for (const item of flagged) {
            try {
                await LocalMaintenanceService.createTask({
                    title: `[Checklist] ${item.text}`,
                    description: `Flagged during checklist run (${item.heading}). Status: FAIL.`,
                    category: 'Repair',
                    trigger_type: 'monthly',
                    interval_value: 30,
                    next_due_date: new Date().toISOString(),
                    next_due_hours: null,
                    last_completed: null,
                    is_active: true,
                });
            } catch (e) {
                log.warn('Failed to create R&M task for:', item.text, e);
            }
        }

        const passCount = runItems.filter((i) => i.status === 'pass').length;
        const failCount = runItems.filter((i) => i.status === 'fail').length;
        const total = runItems.length;

        setShowRun(false);
        setRunItems([]);

        if (failCount > 0) {
            toast.error(`Checklist complete — ${failCount} item${failCount > 1 ? 's' : ''} failed`);
        } else if (passCount === total) {
            toast.success('✅ All items passed!');
        } else {
            toast.success(`Checklist complete — ${passCount}/${total} checked`);
        }

        if (flagged.length > 0) {
            toast.info(`🔧 ${flagged.length} item${flagged.length > 1 ? 's' : ''} sent to R&M`);
        }
    }, [runItems, runId]);

    // Run progress
    const runPassCount = runItems.filter((i) => i.status === 'pass').length;
    const runFailCount = runItems.filter((i) => i.status === 'fail').length;
    const runCheckedCount = runPassCount + runFailCount;
    const runTotal = runItems.length;
    const runProgress = runTotal > 0 ? runCheckedCount / runTotal : 0;

    // Group run items by heading
    const runGrouped = runItems.reduce<{ heading: string; items: ChecklistRunItem[] }[]>((acc, item) => {
        const group = acc.find((g) => g.heading === item.heading);
        if (group) {
            group.items.push(item);
        } else {
            acc.push({ heading: item.heading, items: [item] });
        }
        return acc;
    }, []);

    // ── Render ──
    return (
        <div className="relative h-full bg-slate-950 overflow-hidden">
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Checklists"
                    onBack={onBack}
                    breadcrumbs={["Ship's Office", 'Checklists']}
                    subtitle={
                        <p className="text-label text-gray-400 font-bold uppercase tracking-widest">
                            {headings.length} Section{headings.length !== 1 ? 's' : ''} · {totalDetails} Item
                            {totalDetails !== 1 ? 's' : ''}
                        </p>
                    }
                    action={
                        <div className="relative">
                            <button
                                onClick={() => setHeaderMenuOpen(!headerMenuOpen)}
                                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                                aria-label="Page actions"
                            >
                                <svg className="w-5 h-5 text-gray-400" viewBox="0 0 24 24" fill="currentColor">
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
                                            onClick={startRun}
                                            disabled={totalDetails === 0}
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
                                                    d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                                />
                                            </svg>
                                            Run Checklist
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    }
                />

                {/* Search */}
                <div className="shrink-0 px-4 pb-3">
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search items..."
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 outline-none focus:border-sky-500/30"
                    />
                </div>

                {/* Checklist entries (scrollable, grouped) */}
                <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-4">
                    {loading ? (
                        <div className="space-y-3">
                            {[1, 2, 3].map((i) => (
                                <div
                                    key={i}
                                    className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 flex items-center gap-3"
                                >
                                    <div className="w-8 h-8 rounded-lg skeleton-shimmer" />
                                    <div className="flex-1 space-y-2">
                                        <div className="h-4 w-1/2 rounded-lg skeleton-shimmer" />
                                        <div className="h-3 w-1/4 rounded-lg skeleton-shimmer" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : filtered.length === 0 ? (
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
                                        d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                    />
                                </svg>
                            }
                            title={searchQuery ? 'No Items Match' : 'No Checklists Yet'}
                            subtitle={
                                searchQuery
                                    ? 'Try a different search term.'
                                    : 'Slide below to add your first section or item.'
                            }
                            className="py-16"
                        />
                    ) : (
                        filtered.map((group) => (
                            <div key={group.heading.id}>
                                <SwipeableItemCard
                                    entry={group.heading}
                                    onEdit={() => openEditForm(group.heading)}
                                    onDelete={() => handleDelete(group.heading.id)}
                                    isHeading
                                    itemCount={group.items.length}
                                />
                                <div className="space-y-1.5 mt-1.5">
                                    {group.items.map((item, idx) => (
                                        <SwipeableItemCard
                                            key={item.id}
                                            entry={item}
                                            onEdit={() => openEditForm(item)}
                                            onDelete={() => handleDelete(item.id)}
                                            onMoveUp={() => handleMoveItem(group.items, idx, 'up')}
                                            onMoveDown={() => handleMoveItem(group.items, idx, 'down')}
                                            isFirst={idx === 0}
                                            isLast={idx === group.items.length - 1}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Add CTA */}
                <div
                    className="shrink-0 px-4 pt-2 bg-slate-950"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                >
                    <SlideToAction
                        label="Slide to Add"
                        thumbIcon={
                            <svg
                                className="w-5 h-5 text-white"
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
                            openAddForm();
                        }}
                        theme="emerald"
                    />
                </div>

                {/* ═══ ADD / EDIT MODAL ═══ */}
                {showForm && (
                    <ModalSheet
                        isOpen={true}
                        onClose={() => {
                            setShowForm(false);
                            resetForm();
                        }}
                        title={editEntry ? 'Edit Item' : 'Add to Checklist'}
                        alignTop
                    >
                        {/* Type toggle — Heading or Detail */}
                        {!editEntry && (
                            <div className="mb-4">
                                <label className="text-label text-gray-400 font-bold uppercase tracking-widest block mb-2">
                                    Type
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        onClick={() => setFormType('heading')}
                                        className={`py-3 rounded-xl text-sm font-black uppercase tracking-wider transition-all ${
                                            formType === 'heading'
                                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                                : 'bg-white/5 text-gray-400 border border-white/5'
                                        }`}
                                    >
                                        <svg
                                            className="w-5 h-5 mx-auto mb-1"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.5}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
                                            />
                                        </svg>
                                        Heading
                                    </button>
                                    <button
                                        onClick={() => {
                                            setFormType('detail');
                                            if (headings.length > 0 && !formHeadingId) setFormHeadingId(headings[0].id);
                                        }}
                                        disabled={headings.length === 0}
                                        className={`py-3 rounded-xl text-sm font-black uppercase tracking-wider transition-all ${
                                            formType === 'detail'
                                                ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                                                : 'bg-white/5 text-gray-400 border border-white/5'
                                        } disabled:opacity-30 disabled:cursor-not-allowed`}
                                    >
                                        <svg
                                            className="w-5 h-5 mx-auto mb-1"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.5}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                            />
                                        </svg>
                                        Detail
                                    </button>
                                </div>
                                {headings.length === 0 && formType === 'heading' && (
                                    <p className="text-[11px] text-amber-400/80 mt-2 text-center">
                                        Add a heading first, then you can add detail items
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Heading dropdown (for details only) */}
                        {formType === 'detail' && headings.length > 0 && (
                            <div className="mb-3">
                                <label className="text-label text-gray-400 font-bold uppercase tracking-widest block mb-1.5">
                                    Under Section
                                </label>
                                <select
                                    value={formHeadingId}
                                    onChange={(e) => setFormHeadingId(e.target.value)}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white outline-none focus:border-sky-500/30 appearance-none"
                                >
                                    {headings.map((h) => (
                                        <option key={h.id} value={h.id} className="bg-slate-800">
                                            {h.text}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* Text input */}
                        <div className="mb-4">
                            <FormField
                                label={formType === 'heading' ? 'Section Name' : 'Check Item'}
                                value={formText}
                                onChange={setFormText}
                                placeholder={
                                    formType === 'heading'
                                        ? 'Pre-Start, Shut Down, Navigation...'
                                        : 'Check oil level, test bilge pump...'
                                }
                                required
                            />
                        </div>

                        {!formText.trim() && (
                            <p className="text-micro text-amber-400/80 text-center mt-2">
                                {formType === 'heading' ? 'Section name' : 'Item description'} is required
                            </p>
                        )}
                        <button
                            onClick={handleSave}
                            disabled={!formText.trim()}
                            className={`w-full py-3 mt-1 rounded-xl text-sm font-black text-white uppercase tracking-[0.15em] transition-all active:scale-[0.97] disabled:opacity-30 ${
                                editEntry
                                    ? 'bg-gradient-to-r from-sky-600 to-sky-600 shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500'
                                    : 'bg-gradient-to-r from-emerald-600 to-emerald-600 shadow-lg shadow-emerald-500/20 hover:from-emerald-500 hover:to-emerald-500'
                            }`}
                        >
                            {editEntry ? 'Save Changes' : formType === 'heading' ? 'Add Section' : 'Add Item'}
                        </button>

                        {/* Delete button — only in edit mode */}
                        {editEntry &&
                            (() => {
                                const isHeading = editEntry.type === 'heading';
                                const childCount = isHeading
                                    ? entries.filter((e) => e.type === 'detail' && e.heading_id === editEntry.id).length
                                    : 0;
                                const canDelete = !isHeading || childCount === 0;

                                return (
                                    <>
                                        <button
                                            onClick={() => {
                                                handleDelete(editEntry.id);
                                                setShowForm(false);
                                                resetForm();
                                            }}
                                            disabled={!canDelete}
                                            className="w-full py-3 mt-2 rounded-xl text-sm font-black uppercase tracking-[0.15em] transition-all active:scale-[0.97] bg-red-500/15 border border-red-500/20 text-red-400 hover:bg-red-500/25 disabled:opacity-30"
                                        >
                                            Delete {isHeading ? 'Section' : 'Item'}
                                        </button>
                                        {isHeading && childCount > 0 && (
                                            <p className="text-micro text-amber-400/80 text-center mt-1.5">
                                                Remove all {childCount} item{childCount !== 1 ? 's' : ''} first
                                            </p>
                                        )}
                                    </>
                                );
                            })()}
                    </ModalSheet>
                )}

                {/* ═══ RUN CHECKLIST OVERLAY ═══ */}
                {showRun && (
                    <div
                        className="fixed inset-0 z-[999] bg-slate-950 flex flex-col"
                        style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
                    >
                        {/* Run header */}
                        <div className="shrink-0 px-4 pb-3">
                            <div className="flex items-center justify-between mb-3">
                                <button
                                    onClick={() => {
                                        setShowRun(false);
                                        setRunItems([]);
                                    }}
                                    className="p-2 -ml-2 rounded-xl hover:bg-white/5 transition-colors"
                                >
                                    <svg
                                        className="w-5 h-5 text-gray-400"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M15.75 19.5L8.25 12l7.5-7.5"
                                        />
                                    </svg>
                                </button>
                                <h2 className="text-lg font-black text-white tracking-wide">Run Checklist</h2>
                                <div className="w-9" />
                            </div>

                            {/* Progress bar */}
                            <div className="relative h-2 rounded-full bg-white/[0.06] overflow-hidden mb-1">
                                <div
                                    className="absolute inset-y-0 left-0 rounded-full transition-all duration-500 ease-out"
                                    style={{
                                        width: `${runProgress * 100}%`,
                                        background:
                                            runFailCount > 0
                                                ? 'linear-gradient(90deg, rgba(239,68,68,0.6) 0%, rgba(239,68,68,0.8) 100%)'
                                                : 'linear-gradient(90deg, rgba(16,185,129,0.4) 0%, rgba(16,185,129,0.8) 100%)',
                                    }}
                                />
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] text-gray-400 font-bold uppercase tracking-widest">
                                    {runCheckedCount}/{runTotal} checked
                                </span>
                                <div className="flex items-center gap-3">
                                    {runPassCount > 0 && (
                                        <span className="text-[11px] text-emerald-400 font-bold">✓ {runPassCount}</span>
                                    )}
                                    {runFailCount > 0 && (
                                        <span className="text-[11px] text-red-400 font-bold">✗ {runFailCount}</span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Run items list */}
                        <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-5">
                            {runGrouped.map((group) => (
                                <div key={group.heading}>
                                    {/* Section header */}
                                    <div className="flex items-center gap-2 mb-2.5 sticky top-0 bg-slate-950 py-1 z-10">
                                        <div className="w-1 h-4 rounded-full bg-emerald-500" />
                                        <span className="text-[11px] font-black text-emerald-400 uppercase tracking-[0.2em]">
                                            {group.heading}
                                        </span>
                                    </div>

                                    <div className="space-y-2">
                                        {group.items.map((item) => {
                                            const styles = STATUS_STYLES[item.status];
                                            return (
                                                <div
                                                    key={item.entry_id}
                                                    className={`rounded-xl border ${styles.border} ${styles.bg} overflow-hidden transition-all duration-200`}
                                                >
                                                    <div
                                                        className="flex items-center gap-3 p-3.5 cursor-pointer active:scale-[0.98] transition-transform"
                                                        onClick={() => toggleRunItem(item.entry_id)}
                                                    >
                                                        {/* Status checkbox */}
                                                        <div
                                                            className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-all ${
                                                                item.status === 'pass'
                                                                    ? 'bg-emerald-500/20'
                                                                    : item.status === 'fail'
                                                                      ? 'bg-red-500/20'
                                                                      : 'bg-white/5'
                                                            }`}
                                                        >
                                                            {item.status === 'pass' && (
                                                                <svg
                                                                    className="w-4 h-4 text-emerald-400"
                                                                    fill="none"
                                                                    viewBox="0 0 24 24"
                                                                    stroke="currentColor"
                                                                    strokeWidth={3}
                                                                >
                                                                    <path
                                                                        strokeLinecap="round"
                                                                        strokeLinejoin="round"
                                                                        d="M5 13l4 4L19 7"
                                                                    />
                                                                </svg>
                                                            )}
                                                            {item.status === 'fail' && (
                                                                <svg
                                                                    className="w-4 h-4 text-red-400"
                                                                    fill="none"
                                                                    viewBox="0 0 24 24"
                                                                    stroke="currentColor"
                                                                    strokeWidth={3}
                                                                >
                                                                    <path
                                                                        strokeLinecap="round"
                                                                        strokeLinejoin="round"
                                                                        d="M6 18L18 6M6 6l12 12"
                                                                    />
                                                                </svg>
                                                            )}
                                                            {item.status === 'unchecked' && (
                                                                <div className="w-4 h-4 rounded border-2 border-gray-500/40" />
                                                            )}
                                                        </div>

                                                        {/* Label */}
                                                        <span
                                                            className={`text-sm font-medium flex-1 ${styles.text} ${
                                                                item.status === 'pass' ? 'line-through opacity-60' : ''
                                                            }`}
                                                        >
                                                            {item.text}
                                                        </span>

                                                        {/* R&M flag button (visible when failed) */}
                                                        {item.status === 'fail' && (
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    toggleRmFlag(item.entry_id);
                                                                }}
                                                                className={`shrink-0 px-2 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${
                                                                    item.flagged_rm
                                                                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                                                        : 'bg-white/5 text-gray-400 border border-white/10 hover:text-amber-400'
                                                                }`}
                                                            >
                                                                🔧 R&M
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Complete button */}
                        <div
                            className="shrink-0 px-4 pt-3 bg-slate-950"
                            style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))' }}
                        >
                            <button
                                onClick={completeRun}
                                className={`w-full py-4 rounded-2xl text-sm font-black text-white uppercase tracking-[0.15em] transition-all active:scale-[0.97] shadow-xl ${
                                    runFailCount > 0
                                        ? 'bg-gradient-to-r from-red-600 to-red-700 shadow-red-500/20'
                                        : runCheckedCount === runTotal
                                          ? 'bg-gradient-to-r from-emerald-600 to-emerald-700 shadow-emerald-500/20'
                                          : 'bg-gradient-to-r from-sky-600 to-sky-700 shadow-sky-500/20'
                                }`}
                            >
                                {runCheckedCount === runTotal
                                    ? runFailCount > 0
                                        ? `Complete — ${runFailCount} Failed`
                                        : '✅ All Passed — Complete'
                                    : `Complete (${runCheckedCount}/${runTotal})`}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
