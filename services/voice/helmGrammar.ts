/**
 * helmGrammar — recognise a helm command without a network, an LLM, or a guess.
 *
 * WHY THIS EXISTS. Calypso is four network hops: speech-to-text, Haiku, a tool
 * fetch, Haiku again, then ElevenLabs. Offshore in a squall — which is exactly
 * when a skipper wants to ask something without letting go of the tiller —
 * there is marginal signal or none, so the assistant is least available
 * precisely when it is most wanted. safetyTts.ts already reached this
 * conclusion for MAYDAY: a distress call "CANNOT silently fail because of a
 * network blip". The same is true of "what's the depth".
 *
 * So: a fixed verb set over data the app already holds, matched on-device in
 * microseconds. No model, no inference, no round trip. Anything this file does
 * not recognise falls through to Calypso, which is the right home for
 * open-ended questions when there is a link to carry them.
 *
 * THE MATCHING RULE THAT MATTERS. Read-only questions match LOOSELY — asking
 * the depth twice costs nothing, and a skipper in weather will phrase it
 * however it comes out. Anything with a side effect must match STRICTLY,
 * because "should we anchor here tonight?" must never start an anchor watch.
 * That asymmetry is deliberate and is the reason this file is a hand-written
 * grammar rather than a fuzzy classifier: the failure modes of a fuzzy match
 * are unbounded, and some of these verbs touch safety systems.
 *
 * Pure by design — no imports, no clock, no device. The whole grammar is
 * testable as text in, intent out.
 */

/** Read-only questions answerable from the vessel's own instruments. */
export type HelmQuery =
    | 'depth'
    | 'heading'
    | 'course'
    | 'speed'
    | 'wind'
    | 'position'
    | 'water-temp'
    | 'pressure'
    | 'anchor'
    | 'time';

export interface HelmIntent {
    kind: 'query';
    query: HelmQuery;
}

/**
 * Loose keyword sets. Each entry is a list of alternatives; a phrase matches
 * when every token of any alternative appears in the utterance, in order but
 * not necessarily adjacent. That tolerates the filler a real skipper produces
 * — "uh what's the depth again" — without matching unrelated sentences.
 *
 * Order matters: the first match wins, so more specific phrasings are listed
 * before the bare noun they contain.
 */
const QUERY_PHRASES: ReadonlyArray<readonly [HelmQuery, readonly (readonly string[])[]]> = [
    // Checked before 'wind' and 'course': "wind direction" and "course" both
    // contain tokens that would otherwise be claimed by a looser rule.
    ['anchor', [['anchor'], ['dragging'], ['drag'], ['swing'], ['rode']]],
    ['depth', [['depth'], ['how', 'deep'], ['water', 'under'], ['sounder'], ['under', 'the', 'keel']]],
    ['heading', [['heading'], ['what', 'heading'], ['compass'], ['pointing'], ['bow']]],
    ['course', [['course'], ['cog'], ['course', 'over', 'ground'], ['track']]],
    ['speed', [['speed'], ['sog'], ['how', 'fast'], ['knots', 'are', 'we'], ['making']]],
    ['wind', [['wind'], ['breeze'], ['gust'], ['blowing'], ['apparent'], ['true', 'wind']]],
    [
        'position',
        [
            ['position'],
            ['where', 'are', 'we'],
            ['where', 'am', 'i'],
            ['latitude'],
            ['longitude'],
            ['lat', 'long'],
            ['fix'],
            ['coordinates'],
        ],
    ],
    [
        'water-temp',
        [
            ['water', 'temp'],
            ['water', 'temperature'],
            ['sea', 'temp'],
            ['sea', 'temperature'],
            ['how', 'cold', 'is', 'the', 'water'],
        ],
    ],
    ['pressure', [['pressure'], ['barometer'], ['baro'], ['the', 'glass'], ['millibars'], ['hectopascals']]],
    [
        'time',
        [
            ['what', 'time'],
            ['the', 'time'],
            ['time', 'is', 'it'],
        ],
    ],
];

/**
 * Phrases that look like a helm query but are a request for judgement, not a
 * reading. "Is the depth safe here" wants an opinion; the grammar has none and
 * must not pretend otherwise. These escalate to Calypso.
 *
 * Without this the grammar would confidently answer a different question from
 * the one asked — the single worst failure available to it, because the
 * skipper has no way to tell it happened.
 */
const JUDGEMENT_MARKERS: readonly string[] = [
    'should',
    'safe',
    'ok to',
    'okay to',
    'do you think',
    'would you',
    'is it worth',
    'recommend',
    'advice',
    'enough',
    'too shallow',
    'too deep',
    'reckon',
    'why',
    'explain',
    'forecast',
    'tomorrow',
    'later',
    'tonight',
    'going to',
];

/** Lowercase, strip punctuation, collapse whitespace. */
export function normaliseUtterance(raw: string): string {
    return (raw || '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/** Do all of `tokens` appear in `words`, in order? */
function containsInOrder(words: readonly string[], tokens: readonly string[]): boolean {
    let at = 0;
    for (const token of tokens) {
        const found = words.indexOf(token, at);
        if (found === -1) return false;
        at = found + 1;
    }
    return true;
}

/**
 * Parse an utterance into a helm intent, or null if this grammar does not
 * confidently own it.
 *
 * Null is the common and correct answer — it means "let Calypso have it". The
 * grammar is deliberately narrow, because a wrong reading spoken with
 * confidence is worse than no reading at all.
 */
export function parseHelmCommand(raw: string): HelmIntent | null {
    const text = normaliseUtterance(raw);
    if (!text) return null;

    // A request for judgement is never a reading, however many instrument
    // words it happens to contain.
    if (JUDGEMENT_MARKERS.some((marker) => text.includes(marker))) return null;

    // Long utterances are conversation, not commands. A real helm question is
    // short because the skipper is busy; anything rambling belongs to Calypso.
    const words = text.split(' ');
    if (words.length > 8) return null;

    for (const [query, alternatives] of QUERY_PHRASES) {
        for (const tokens of alternatives) {
            if (containsInOrder(words, tokens)) return { kind: 'query', query };
        }
    }
    return null;
}
