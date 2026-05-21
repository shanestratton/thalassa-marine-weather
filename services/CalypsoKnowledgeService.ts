/**
 * CalypsoKnowledgeService — per-user knowledge base that Calypso draws
 * on to "know your boat". Top-tier feature.
 *
 * Storage: the `vessel_knowledge` Supabase table (RLS-scoped to the
 * signed-in user, so a fetch only ever returns that user's rows). The
 * client fetches the rows and folds them into Calypso's system prompt
 * (orchestrator = primary path; edge function = fallback). See
 * formatKnowledgeForPrompt below for the prompt-block shape and the
 * medical recall-not-advise framing the prompt guardrail relies on.
 */
import { supabase } from './supabase';
import { createLogger } from '../utils/createLogger';

const log = createLogger('CalypsoKnowledge');

export type KnowledgeCategory = 'vessel_spec' | 'medical' | 'recipe' | 'maintenance' | 'crew_pref' | 'general';

export interface VesselKnowledge {
    id: string;
    user_id: string;
    category: KnowledgeCategory;
    title: string;
    body: string;
    created_at: string;
    updated_at: string;
}

/** Display metadata for the Settings UI + prompt grouping. Order here is
 *  the order categories appear in the prompt + the picker. */
export const KNOWLEDGE_CATEGORIES: { id: KnowledgeCategory; label: string; hint: string }[] = [
    {
        id: 'vessel_spec',
        label: 'Vessel Specs',
        hint: 'Dimensions, tankage, rig, gear — facts Calypso can state outright.',
    },
    { id: 'maintenance', label: 'Maintenance', hint: 'Service history, part numbers, intervals.' },
    {
        id: 'medical',
        label: 'Medical',
        hint: 'Allergies, meds, kit location. Calypso recalls these — never diagnoses.',
    },
    { id: 'recipe', label: 'Recipes', hint: 'Galley favourites for passage cooking.' },
    { id: 'crew_pref', label: 'Crew & Preferences', hint: 'Crew names, watch prefs, how you like things done.' },
    { id: 'general', label: 'General', hint: 'Anything else you want Calypso to remember.' },
];

const CATEGORY_LABEL: Record<KnowledgeCategory, string> = KNOWLEDGE_CATEGORIES.reduce(
    (acc, c) => ({ ...acc, [c.id]: c.label }),
    {} as Record<KnowledgeCategory, string>,
);

/** Fetch all of the signed-in user's knowledge rows (RLS-scoped). */
export async function getKnowledge(): Promise<VesselKnowledge[]> {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('vessel_knowledge')
        .select('*')
        .order('category', { ascending: true })
        .order('updated_at', { ascending: false });
    if (error) {
        log.warn('getKnowledge failed:', error.message);
        return [];
    }
    return (data ?? []) as VesselKnowledge[];
}

export async function addKnowledge(
    category: KnowledgeCategory,
    title: string,
    body: string,
): Promise<VesselKnowledge | null> {
    if (!supabase) return null;
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        log.warn('addKnowledge: not signed in');
        return null;
    }
    const { data, error } = await supabase
        .from('vessel_knowledge')
        .insert({ user_id: user.id, category, title: title.trim(), body: body.trim() })
        .select()
        .single();
    if (error) {
        log.warn('addKnowledge failed:', error.message);
        return null;
    }
    invalidateKnowledgeBlock();
    return data as VesselKnowledge;
}

export async function updateKnowledge(
    id: string,
    patch: Partial<Pick<VesselKnowledge, 'category' | 'title' | 'body'>>,
): Promise<boolean> {
    if (!supabase) return false;
    const trimmed = {
        ...patch,
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.body !== undefined ? { body: patch.body.trim() } : {}),
    };
    const { error } = await supabase.from('vessel_knowledge').update(trimmed).eq('id', id);
    if (error) {
        log.warn('updateKnowledge failed:', error.message);
        return false;
    }
    invalidateKnowledgeBlock();
    return true;
}

export async function deleteKnowledge(id: string): Promise<boolean> {
    if (!supabase) return false;
    const { error } = await supabase.from('vessel_knowledge').delete().eq('id', id);
    if (error) {
        log.warn('deleteKnowledge failed:', error.message);
        return false;
    }
    invalidateKnowledgeBlock();
    return true;
}

/**
 * Format knowledge rows into a system-prompt block. Grouped by category
 * so the prompt guardrail can key behaviour off the heading (esp.
 * MEDICAL = recall-not-advise). Returns '' when there's nothing, so the
 * caller can skip the section entirely. Capped to keep the prompt (and
 * the prompt-cache) bounded — oldest-edited rows drop first.
 */
const MAX_PROMPT_ROWS = 60;

export function formatKnowledgeForPrompt(rows: VesselKnowledge[]): string {
    if (rows.length === 0) return '';
    const capped = rows.slice(0, MAX_PROMPT_ROWS);
    const byCategory = new Map<KnowledgeCategory, VesselKnowledge[]>();
    for (const r of capped) {
        const list = byCategory.get(r.category) ?? [];
        list.push(r);
        byCategory.set(r.category, list);
    }
    const sections: string[] = [];
    // Emit in the canonical category order.
    for (const { id } of KNOWLEDGE_CATEGORIES) {
        const list = byCategory.get(id);
        if (!list || list.length === 0) continue;
        const lines = list.map((r) => `- ${r.title}: ${r.body}`.trim()).join('\n');
        sections.push(`### ${CATEGORY_LABEL[id]}\n${lines}`);
    }
    return sections.join('\n\n');
}

/**
 * The full system-prompt block (header + formatted rows) Calypso reads.
 * The header carries the behaviour rules — assert specs as fact, and the
 * critical MEDICAL recall-not-advise guardrail — keyed off the category
 * headings the formatter emits.
 */
export function buildKnowledgePromptBlock(rows: VesselKnowledge[]): string {
    const body = formatKnowledgeForPrompt(rows);
    if (!body) return '';
    return [
        "## SKIPPER'S KNOWLEDGE BASE",
        "The skipper has taught you these facts about their boat. Treat them as authoritative for THIS vessel — you may state them outright. For the MEDICAL section: recall the skipper's stored notes verbatim if asked (allergies, medications, kit location), but NEVER diagnose, dose, or give medical advice beyond what is written here — defer to a doctor, the ship's medical guide, or a medical-radio call.",
        '',
        body,
    ].join('\n');
}

// ── Memoised prompt block ────────────────────────────────────────────
// The orchestrator builds the system prompt on every turn; we must NOT
// hit Supabase each time. Cache the formatted block; invalidate on any
// local mutation so edits in Settings reflect on the next chat.
let _blockCache: { text: string; fetchedAt: number } | null = null;
const BLOCK_TTL_MS = 5 * 60 * 1000;

/** Clear the cached prompt block (called after any mutation). */
export function invalidateKnowledgeBlock(): void {
    _blockCache = null;
}

/**
 * Cached system-prompt block for Calypso. Refetches at most every 5 min
 * (or immediately after an edit). Returns '' when the user has no
 * knowledge rows, so the caller skips the section entirely.
 */
export async function getKnowledgePromptBlock(): Promise<string> {
    const now = Date.now();
    if (_blockCache && now - _blockCache.fetchedAt < BLOCK_TTL_MS) {
        return _blockCache.text;
    }
    const rows = await getKnowledge();
    const text = buildKnowledgePromptBlock(rows);
    _blockCache = { text, fetchedAt: now };
    return text;
}
