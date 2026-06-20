/**
 * Weather Window Scorer — the interactive, scored version of the Go/No-Go card.
 *
 * The skipper answers each question; the engine returns a 0–100 score plus a
 * verdict. To call it a window the score must clear GO_THRESHOLD AND no veto
 * gate may be tripped.
 *
 * SAFETY DESIGN — gates beat the score. A purely additive score is dangerous:
 * you could bank points on a flat sea and a rested crew and "score away" a
 * cyclone in your track. So four hard gates (named system, no bail-out, closing
 * window, unrested crew) force NO-GO regardless of the number. This mirrors the
 * AUTO NO-GO list on the printed card. The score then grades everything else.
 *
 * This module is PURE and dependency-free on purpose — it is the shared brain
 * for both the in-app questionnaire UI and Bosun (Pi) voice ("is Thursday a
 * window?"). It is a DECISION AID, never the decision. The skipper decides,
 * against official forecasts.
 */

/** Tunable thresholds (0–100). Calibrate to taste / vessel / risk appetite. */
export const GO_THRESHOLD = 80;
export const MARGINAL_THRESHOLD = 60;

export const DISCLAIMER =
    'Decision aid only — verify against official forecasts and your own eyes. The skipper decides. ' +
    'A window you have to talk yourself into isn’t a window.';

export type Quality = number; // 0 (bad) .. 1 (ideal)

export interface ScoredOption {
    id: string;
    label: string;
    quality: Quality;
}
export interface ScoredQuestion {
    kind: 'scored';
    id: string;
    prompt: string;
    help?: string;
    /** Relative importance. Higher = pulls the score harder. */
    weight: number;
    options: ScoredOption[];
}
export interface GateOption {
    id: string;
    label: string;
    /** true → choosing this answer forces NO-GO. */
    veto: boolean;
}
export interface GateQuestion {
    kind: 'gate';
    id: string;
    prompt: string;
    help?: string;
    /** Shown when the veto answer is chosen. */
    vetoReason: string;
    options: GateOption[];
}
export type Question = ScoredQuestion | GateQuestion;

/** Answers keyed by question id → chosen option id. */
export type Answers = Record<string, string>;

export type Band = 'GO' | 'MARGINAL' | 'NO-GO';

export interface WeatherWindowResult {
    /** 0–100 over the scored questions answered. */
    score: number;
    band: Band;
    /** Human-readable reasons the window is vetoed (empty if none). */
    vetoes: string[];
    /** The answered scored questions dragging the score down (quality < 0.7). */
    weakest: { id: string; prompt: string; choice: string; quality: Quality }[];
    /** Every scored + gate question answered? Verdict is provisional until true. */
    complete: boolean;
    answered: number;
    total: number;
    /** One-line plain-English verdict. */
    verdict: string;
    disclaimer: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The question set. Gates first (hard NO-GO), then the weighted scored questions
// mapped to the Go/No-Go card's six steps + forecast confidence.
// ─────────────────────────────────────────────────────────────────────────────
export const QUESTIONS: Question[] = [
    // ── Hard gates ──
    {
        kind: 'gate',
        id: 'tropical_system',
        prompt: 'Is a named tropical cyclone — or a developing tropical low — anywhere in your route or time window?',
        vetoReason: 'A tropical system is in play. You can’t outrun one; you don’t go.',
        options: [
            { id: 'no', label: 'No — nothing tropical in the picture', veto: false },
            { id: 'yes', label: 'Yes — a system is in or near the track/window', veto: true },
        ],
    },
    {
        kind: 'gate',
        id: 'bailout',
        prompt: 'Is there at least one all-weather bolt-hole you can reach before conditions turn?',
        help: 'Reachable on your bad-day speed, and genuinely all-weather for the expected wind direction.',
        vetoReason: 'No viable all-weather bail-out. In marginal weather that’s an automatic no.',
        options: [
            { id: 'yes', label: 'Yes — at least one, and I’ve marked it', veto: false },
            { id: 'no', label: 'No reliable refuge before it turns', veto: true },
        ],
    },
    {
        kind: 'gate',
        id: 'closing_window',
        prompt: 'Does the good weather hold/open across the passage — or does it close before you’d arrive with margin?',
        vetoReason: 'The window is closing. The back end is where people get caught — don’t leave on it.',
        options: [
            { id: 'holds', label: 'Holds or opens — I arrive with margin', veto: false },
            { id: 'closing', label: 'Closes / deteriorates before I’m in', veto: true },
        ],
    },
    {
        kind: 'gate',
        id: 'crew_rested',
        prompt: 'Is the crew rested and fit for the whole passage?',
        vetoReason: 'Crew not rested. Fatigue is a hazard before you’ve even slipped lines.',
        options: [
            { id: 'yes', label: 'Yes — rested and ready', veto: false },
            { id: 'no', label: 'No — tired, sick, or short-handed', veto: true },
        ],
    },

    // ── Scored questions ──
    {
        kind: 'scored',
        id: 'window_margin',
        weight: 3,
        prompt: 'Window length vs the time you actually need (at honest bad-day speed)?',
        help: 'Distance ÷ bad-day speed = hours needed. Then compare to the good-weather window.',
        options: [
            { id: 'over2', label: 'More than 2× the time I need', quality: 1.0 },
            { id: 'm15_2', label: '1.5–2× — comfortable margin', quality: 0.8 },
            { id: 'm1_15', label: '1–1.5× — thin', quality: 0.4 },
            { id: 'under1', label: 'Less than 1× — I’d be racing it', quality: 0.0 },
        ],
    },
    {
        kind: 'scored',
        id: 'sustained_wind',
        weight: 3,
        prompt: 'Forecast sustained wind vs your boat’s comfortable working limit?',
        options: [
            { id: 'within', label: 'Well within — easy sailing', quality: 1.0 },
            { id: 'near', label: 'Near my limit', quality: 0.55 },
            { id: 'at', label: 'At or just above it', quality: 0.1 },
            { id: 'over', label: 'Well above my limit', quality: 0.0 },
        ],
    },
    {
        kind: 'scored',
        id: 'gusts',
        weight: 2,
        prompt: 'Gusts (assume the forecast under-reads them) vs what you can hold?',
        options: [
            { id: 'ok', label: 'Comfortably handled', quality: 1.0 },
            { id: 'reef', label: 'Reef down and cope', quality: 0.5 },
            { id: 'beyond', label: 'Beyond comfortable', quality: 0.05 },
        ],
    },
    {
        kind: 'scored',
        id: 'sea_state',
        weight: 3,
        prompt: 'Sea & swell — height and period together?',
        help: 'Short period + height = steep and breaking. Long-period swell is a lift, not a fight.',
        options: [
            { id: 'low_long', label: 'Low, long-period — a nap', quality: 1.0 },
            { id: 'moderate', label: 'Moderate', quality: 0.65 },
            { id: 'short_steep', label: 'Short-period / steep', quality: 0.2 },
            { id: 'dangerous', label: 'Large & dangerous', quality: 0.0 },
        ],
    },
    {
        kind: 'scored',
        id: 'sea_direction',
        weight: 2,
        prompt: 'Dominant sea/swell direction relative to your course?',
        options: [
            { id: 'astern', label: 'Astern / quartering — favourable', quality: 1.0 },
            { id: 'beam', label: 'On the beam', quality: 0.5 },
            { id: 'nose', label: 'On the nose / building', quality: 0.25 },
        ],
    },
    {
        kind: 'scored',
        id: 'system_trend',
        weight: 2,
        prompt: 'What’s the weather doing across the window?',
        options: [
            { id: 'easing', label: 'Easing & stable', quality: 1.0 },
            { id: 'steady', label: 'Steady', quality: 0.7 },
            { id: 'building', label: 'Building moderately', quality: 0.35 },
            { id: 'fast', label: 'Building fast', quality: 0.05 },
        ],
    },
    {
        kind: 'scored',
        id: 'model_confidence',
        weight: 2,
        prompt: 'How well do the forecast models / GRIBs agree?',
        help: 'Divergence = high uncertainty. Plan to the worst of the cluster.',
        options: [
            { id: 'agree', label: 'Strong agreement', quality: 1.0 },
            { id: 'minor', label: 'Minor spread', quality: 0.6 },
            { id: 'diverge', label: 'Big divergence', quality: 0.2 },
        ],
    },
    {
        kind: 'scored',
        id: 'wind_over_tide',
        weight: 1,
        prompt: 'Wind-against-tide or current anywhere on the route?',
        options: [
            { id: 'none', label: 'None / with the flow', quality: 1.0 },
            { id: 'some', label: 'Some', quality: 0.5 },
            { id: 'against', label: 'Significant — wind against a strong set', quality: 0.15 },
        ],
    },
    {
        kind: 'scored',
        id: 'visibility_night',
        weight: 1,
        prompt: 'Visibility and night exposure in tricky water?',
        options: [
            { id: 'good', label: 'Good viz, mostly daylight', quality: 1.0 },
            { id: 'some_night', label: 'Some night, open water', quality: 0.6 },
            { id: 'poor', label: 'Poor viz / night in pilotage water', quality: 0.2 },
        ],
    },
    {
        kind: 'scored',
        id: 'crew_experience',
        weight: 2,
        prompt: 'Crew experience vs the conditions you actually expect?',
        options: [
            { id: 'strong', label: 'Strong for these conditions', quality: 1.0 },
            { id: 'adequate', label: 'Adequate', quality: 0.6 },
            { id: 'stretched', label: 'Stretched', quality: 0.2 },
        ],
    },
];

const VERDICTS: Record<Band, string> = {
    GO: 'Clears the bar — this looks like a window. Final call is yours, against the official forecast.',
    MARGINAL: 'Marginal — only if you’re rigged for the worst of it and your bail-outs are solid.',
    'NO-GO': 'Not a window. Wait for a better one.',
};

/** Score a set of answers. Pure — safe to run on the Pi or in the app. */
export function scoreWeatherWindow(answers: Answers): WeatherWindowResult {
    const gates = QUESTIONS.filter((q): q is GateQuestion => q.kind === 'gate');
    const scored = QUESTIONS.filter((q): q is ScoredQuestion => q.kind === 'scored');

    // 1. Gates — any tripped veto forces NO-GO.
    const vetoes: string[] = [];
    for (const g of gates) {
        const opt = g.options.find((o) => o.id === answers[g.id]);
        if (opt?.veto) vetoes.push(g.vetoReason);
    }

    // 2. Weighted score over answered scored questions.
    let acc = 0;
    let wsum = 0;
    let answeredScored = 0;
    const perQuestion: { id: string; prompt: string; choice: string; quality: Quality }[] = [];
    for (const q of scored) {
        const opt = q.options.find((o) => o.id === answers[q.id]);
        if (!opt) continue;
        answeredScored += 1;
        acc += opt.quality * q.weight;
        wsum += q.weight;
        perQuestion.push({ id: q.id, prompt: q.prompt, choice: opt.label, quality: opt.quality });
    }
    const score = wsum > 0 ? Math.round((acc / wsum) * 100) : 0;

    const answeredGates = gates.filter((g) => answers[g.id] != null).length;
    const complete = answeredGates === gates.length && answeredScored === scored.length;

    // 3. Band — gates override the number.
    let band: Band;
    if (vetoes.length > 0) band = 'NO-GO';
    else if (score >= GO_THRESHOLD) band = 'GO';
    else if (score >= MARGINAL_THRESHOLD) band = 'MARGINAL';
    else band = 'NO-GO';

    const weakest = perQuestion
        .filter((p) => p.quality < 0.7)
        .sort((a, b) => a.quality - b.quality)
        .slice(0, 3);

    let verdict = VERDICTS[band];
    if (!complete) verdict = `Answer all questions for a full read. So far: ${verdict}`;

    return {
        score,
        band,
        vetoes,
        weakest,
        complete,
        answered: answeredGates + answeredScored,
        total: QUESTIONS.length,
        verdict,
        disclaimer: DISCLAIMER,
    };
}
