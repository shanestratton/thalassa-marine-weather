/**
 * The under-way alarms' cards and strip notices (build 126, 126-02a).
 *
 * Small and static: it ships with the app shell, so the alarm stack
 * (components/map/AisGuardAlert.tsx) knows at once whether there is anything
 * to show, while the watch (./UnderwayAlarmWatch.ts), the rule and the cards
 * (components/map/UnderwayAlarmCards.tsx) load lazily. The watch writes here;
 * the cards' buttons act here, and the watch hears them at once.
 *
 * Order is fixed: shoal water first, then off route (the danger under the
 * keel is now; the line can wait a minute), then (126-02b) the watch check.
 * All sit under the collision cards. The under-way watch and the watch check
 * (./watchCheck.ts) each publish their own part; neither can clear the other's.
 */

/** The under-way watch's two alarms. */
export type UnderwayAlarmKind = 'shoal' | 'off-route';
/** A card in the stack: the under-way watch's two, and the watch check (126-02b). */
export type UnderwayCardKind = UnderwayAlarmKind | 'watch-check';

export interface UnderwayAlarmCard {
    kind: UnderwayCardKind;
    title: string;
    /** The number, said plainly ('0.40 NM off the line', 'about 0.4 m under the keel'). */
    value: string;
    /** What it is measured from. */
    detail: string;
    note?: string;
    /** Sounding now (not muted, not acknowledged). */
    sounding: boolean;
    /** Off route muted until then (epoch ms), else null. */
    mutedUntil: number | null;
}

export interface UnderwayAlarmAction {
    kind: UnderwayCardKind;
    nowMs: number;
}

const ORDER: Record<UnderwayCardKind, number> = { shoal: 0, 'off-route': 1, 'watch-check': 2 };
const MUTE_MS = 30 * 60_000;

/** What the under-way watch last published, and what the watch check last published. */
let own: { cards: UnderwayAlarmCard[]; notices: string[] } = { cards: [], notices: [] };
let check: { cards: UnderwayAlarmCard[]; notices: string[] } = { cards: [], notices: [] };
let cards: UnderwayAlarmCard[] = [];
let notices: string[] = [];
let signature = '';
const listeners = new Set<() => void>();
const actionListeners = new Set<(action: UnderwayAlarmAction) => void>();

function signatureOf(nextCards: UnderwayAlarmCard[], nextNotices: string[]): string {
    return JSON.stringify([nextCards, nextNotices]);
}

function emit(): void {
    for (const l of listeners) l();
}

/** Both parts as one stack. Re-renders only when something changed. */
function merge(): void {
    const sorted = [...own.cards, ...check.cards].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
    const nextNotices = [...own.notices, ...check.notices];
    const next = signatureOf(sorted, nextNotices);
    if (next === signature) return;
    signature = next;
    cards = sorted;
    notices = nextNotices;
    emit();
}

function act(action: UnderwayAlarmAction): void {
    for (const l of actionListeners) {
        try {
            l(action);
        } catch {
            /* One listener must not keep the action from the others. */
        }
    }
}

export const UnderwayAlarmStore = {
    getCards(): UnderwayAlarmCard[] {
        return cards;
    },

    getNotices(): string[] {
        return notices;
    },

    hasEntries(): boolean {
        return cards.length > 0 || notices.length > 0;
    },

    anySounding(): boolean {
        return cards.some((c) => c.sounding);
    },

    /** The under-way watch's whole word for this pass. Re-renders only when something changed. */
    set(nextCards: UnderwayAlarmCard[], nextNotices: string[]): void {
        own = { cards: nextCards.filter((c) => c.kind !== 'watch-check'), notices: [...nextNotices] };
        merge();
    },

    /** The watch check's whole word (126-02b): its one card or none, and its strip notices. */
    setWatchCheck(card: UnderwayAlarmCard | null, nextNotices: string[]): void {
        check = { cards: card ? [{ ...card, kind: 'watch-check' }] : [], notices: [...nextNotices] };
        merge();
    },

    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    /** Off route's Mute 30 min: silent, the card kept, saying until when. */
    mute(kind: 'off-route', nowMs = Date.now()): void {
        const until = nowMs + MUTE_MS;
        UnderwayAlarmStore.set(
            own.cards.map((c) => (c.kind === kind && c.sounding ? { ...c, sounding: false, mutedUntil: until } : c)),
            own.notices,
        );
        act({ kind, nowMs });
    },

    /** Shoal's Acknowledge: silent, and the card stands aside until the water deepens and it re-arms. */
    acknowledge(kind: 'shoal', nowMs = Date.now()): void {
        UnderwayAlarmStore.set(
            own.cards.filter((c) => c.kind !== kind),
            own.notices,
        );
        act({ kind, nowMs });
    },

    /**
     * The watch check's "I'm on watch" (126-02b): the only answer it takes.
     * The watch check hears it at once, silences, and books the next check.
     */
    onWatch(nowMs = Date.now()): void {
        act({ kind: 'watch-check', nowMs });
    },

    /** The watch hears the buttons here, at once. */
    subscribeActions(listener: (action: UnderwayAlarmAction) => void): () => void {
        actionListeners.add(listener);
        return () => actionListeners.delete(listener);
    },

    /** Tests: no cards, no notices. The watch keeps listening. */
    clear(): void {
        own = { cards: [], notices: [] };
        check = { cards: [], notices: [] };
        cards = [];
        notices = [];
        signature = signatureOf([], []);
        emit();
    },
};
