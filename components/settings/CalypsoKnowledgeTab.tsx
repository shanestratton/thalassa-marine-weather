/**
 * CalypsoKnowledgeTab — manage the per-user knowledge base Calypso draws
 * on to "know your boat". Top-tier feature; all the Thalassa-side UI for
 * the knowledge base lives here (per Shane, 2026-05-22).
 *
 * Each entry is a titled note in a category. On save, the orchestrator
 * re-fetches and folds these into Calypso's system prompt on the next
 * conversation, so what you add here is what Calypso then knows.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Section, type SettingsTabProps } from './SettingsPrimitives';
import { toast } from '../Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import {
    getKnowledge,
    addKnowledge,
    updateKnowledge,
    deleteKnowledge,
    KNOWLEDGE_CATEGORIES,
    type VesselKnowledge,
    type KnowledgeCategory,
} from '../../services/CalypsoKnowledgeService';

interface DraftState {
    id: string | null; // null = new entry
    category: KnowledgeCategory;
    title: string;
    body: string;
}

const EMPTY_DRAFT: DraftState = { id: null, category: 'vessel_spec', title: '', body: '' };

export const CalypsoKnowledgeTab: React.FC<SettingsTabProps> = ({ settings }) => {
    // Top-tier (Skipper / 'owner') feature. Non-owners see an upsell
    // wall rather than a hidden tab — keeps it discoverable.
    const isTopTier = settings?.subscriptionTier === 'owner';
    const [items, setItems] = useState<VesselKnowledge[]>([]);
    const [loading, setLoading] = useState(true);
    const [draft, setDraft] = useState<DraftState | null>(null);
    const [saving, setSaving] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<VesselKnowledge | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setItems(await getKnowledge());
        } catch {
            toast.error('Could not load Calypso knowledge.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const handleSave = useCallback(async () => {
        if (!draft || !draft.title.trim()) {
            toast.error('Give the note a title.');
            return;
        }
        setSaving(true);
        try {
            const ok = draft.id
                ? await updateKnowledge(draft.id, { category: draft.category, title: draft.title, body: draft.body })
                : !!(await addKnowledge(draft.category, draft.title, draft.body));
            if (!ok) {
                toast.error('Save failed — try again.');
                return;
            }
            toast.success(draft.id ? 'Updated' : 'Added — Calypso will know this next chat');
            setDraft(null);
            await load();
        } finally {
            setSaving(false);
        }
    }, [draft, load]);

    const confirmDelete = useCallback(async () => {
        if (!pendingDelete) return;
        const target = pendingDelete;
        setPendingDelete(null);
        // Optimistic remove + restore on failure.
        setItems((prev) => prev.filter((i) => i.id !== target.id));
        const ok = await deleteKnowledge(target.id);
        if (!ok) {
            toast.error('Delete failed — restoring.');
            void load();
        } else {
            toast.success('Removed');
        }
    }, [pendingDelete, load]);

    const grouped = KNOWLEDGE_CATEGORIES.map((c) => ({
        cat: c,
        rows: items.filter((i) => i.category === c.id),
    })).filter((g) => g.rows.length > 0);

    // ── Upsell wall for non-top-tier ──
    if (!isTopTier) {
        return (
            <div className="max-w-2xl mx-auto w-full">
                <div className="p-6 rounded-2xl bg-gradient-to-br from-cyan-500/10 to-transparent border border-cyan-500/20 text-center">
                    <h2 className="text-lg font-bold text-white mb-2">Calypso's Knowledge</h2>
                    <p className="text-[13px] text-slate-300 leading-relaxed mb-1">
                        Teach Calypso about your boat — specs, recipes, maintenance history, crew notes — so it answers
                        like a first mate who's sailed with you for years.
                    </p>
                    <p className="text-[12px] text-cyan-300/80 font-semibold mt-3">A Skipper-tier feature.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-2xl mx-auto w-full">
            {/* Intro */}
            <div className="mb-6 p-4 rounded-2xl bg-gradient-to-br from-cyan-500/10 to-transparent border border-cyan-500/20">
                <h2 className="text-lg font-bold text-white mb-1">Calypso's Knowledge</h2>
                <p className="text-[12px] text-slate-300 leading-relaxed">
                    Teach Calypso about your boat. Anything you add here — specs, recipes, basic medical notes,
                    maintenance history — folds into Calypso's memory on your next chat. Calypso states these as fact,
                    so keep them accurate.
                </p>
                <p className="text-[12px] text-amber-300/80 leading-relaxed mt-2">
                    Medical notes are <strong>recalled, never diagnosed</strong> — Calypso will read your stored notes
                    back to you (allergies, kit location) but won't give medical advice. For that, call a doctor or
                    medical radio.
                </p>
            </div>

            {/* Add button */}
            {!draft && (
                <button
                    onClick={() => setDraft({ ...EMPTY_DRAFT })}
                    className="w-full mb-6 py-3 rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-300 font-bold text-sm hover:bg-sky-500/25 transition-colors active:scale-[0.98]"
                >
                    + Add something Calypso should know
                </button>
            )}

            {/* Editor */}
            {draft && (
                <div className="mb-6 p-4 rounded-2xl bg-white/[0.04] border border-white/10 space-y-3">
                    <div className="flex flex-wrap gap-1.5">
                        {KNOWLEDGE_CATEGORIES.map((c) => (
                            <button
                                key={c.id}
                                onClick={() => setDraft((d) => (d ? { ...d, category: c.id } : d))}
                                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wide transition-colors ${
                                    draft.category === c.id
                                        ? 'bg-sky-500 text-white'
                                        : 'bg-white/[0.04] text-slate-400 hover:text-slate-200'
                                }`}
                            >
                                {c.label}
                            </button>
                        ))}
                    </div>
                    <p className="text-[11px] text-slate-500 px-1">
                        {KNOWLEDGE_CATEGORIES.find((c) => c.id === draft.category)?.hint}
                    </p>
                    <input
                        type="text"
                        value={draft.title}
                        onChange={(e) => setDraft((d) => (d ? { ...d, title: e.target.value } : d))}
                        placeholder="Title (e.g. Tender, Penicillin allergy, Anchor windlass)"
                        className="w-full h-11 px-3 rounded-xl bg-black/40 border border-white/10 text-white text-sm focus:border-sky-500/50 outline-none placeholder-slate-600"
                    />
                    <textarea
                        value={draft.body}
                        onChange={(e) => setDraft((d) => (d ? { ...d, body: e.target.value } : d))}
                        placeholder="Details Calypso should remember…"
                        rows={4}
                        className="w-full px-3 py-2.5 rounded-xl bg-black/40 border border-white/10 text-white text-sm focus:border-sky-500/50 outline-none placeholder-slate-600 resize-y leading-relaxed"
                    />
                    <div className="flex gap-2">
                        <button
                            onClick={handleSave}
                            disabled={saving || !draft.title.trim()}
                            className="flex-1 py-2.5 rounded-xl bg-sky-500 text-white font-bold text-sm disabled:opacity-50 active:scale-[0.98] transition-all"
                        >
                            {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Add'}
                        </button>
                        <button
                            onClick={() => setDraft(null)}
                            className="px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-slate-300 font-bold text-sm hover:bg-white/10 transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {/* List */}
            {loading ? (
                <div className="space-y-3">
                    {[0, 1, 2].map((i) => (
                        <div
                            key={i}
                            className="h-24 rounded-2xl bg-white/[0.03] border border-white/[0.06] animate-pulse"
                        />
                    ))}
                </div>
            ) : items.length === 0 && !draft ? (
                <p className="text-sm text-slate-500 text-center py-8 leading-relaxed">
                    Nothing yet. Add your vessel specs, a few recipes, crew notes — whatever you'd want a sharp first
                    mate to know.
                </p>
            ) : (
                grouped.map(({ cat, rows }) => (
                    <Section key={cat.id} title={cat.label}>
                        {rows.map((row, i) => (
                            <div
                                key={row.id}
                                className={`p-4 ${i > 0 ? 'border-t border-white/[0.06]' : ''} flex items-start gap-3`}
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-bold text-white">{row.title}</div>
                                    {row.body && (
                                        <div className="text-[12px] text-slate-400 mt-0.5 leading-relaxed whitespace-pre-wrap">
                                            {row.body}
                                        </div>
                                    )}
                                </div>
                                <div className="flex gap-1 shrink-0">
                                    <button
                                        aria-label={`Edit ${row.title}`}
                                        onClick={() =>
                                            setDraft({
                                                id: row.id,
                                                category: row.category,
                                                title: row.title,
                                                body: row.body,
                                            })
                                        }
                                        className="w-9 h-9 rounded-lg bg-white/5 text-slate-400 hover:text-sky-300 hover:bg-white/10 transition-colors flex items-center justify-center text-xs font-bold"
                                    >
                                        Edit
                                    </button>
                                    <button
                                        aria-label={`Delete ${row.title}`}
                                        onClick={() => setPendingDelete(row)}
                                        className="w-9 h-9 rounded-lg bg-white/5 text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors flex items-center justify-center"
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
                                                d="M6 18L18 6M6 6l12 12"
                                            />
                                        </svg>
                                    </button>
                                </div>
                            </div>
                        ))}
                    </Section>
                ))
            )}

            {pendingDelete && (
                <ConfirmDialog
                    isOpen
                    destructive
                    title="Remove this note?"
                    message={`Calypso will forget "${pendingDelete.title}".`}
                    confirmLabel="Remove"
                    onConfirm={confirmDelete}
                    onCancel={() => setPendingDelete(null)}
                />
            )}
        </div>
    );
};
