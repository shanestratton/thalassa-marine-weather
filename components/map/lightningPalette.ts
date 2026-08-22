/**
 * lightningPalette — ONE definition of what each strike polarity looks like.
 *
 * The legend in BlitzortungAttribution.tsx carried this comment:
 *
 *   "must stay visually identical to the actual strike rendering in
 *    useLightningLayer.ts … If you change the colors there, change them here
 *    too."
 *
 * They drifted anyway, which is what always happens to a rule enforced by a
 * comment. By 2026-08-23 the legend showed deep navy for −CG while the map
 * painted amber, deep brown for +CG against orange, and indigo for unknown
 * against yellow — three swatches, none of them the colour on screen. On a
 * navigation app a legend that names the wrong colour is worse than no legend:
 * it invites you to read polarity off the chart and get it backwards.
 *
 * So the colours live here, both sides import them, and a test pins that
 * neither hard-codes its own.
 *
 * WHAT THE LABELS MEAN. CG is cloud-to-ground, and the sign is the polarity
 * of the charge lowered to earth:
 *  · −CG — the ordinary kind, ~90-95% of ground strikes, from the mid-level
 *    negative charge region. Median peak current around 30 kA, usually several
 *    return strokes (that is the flicker you see).
 *  · +CG — ~5-10%, lowered from the positive charge in the anvil. Far higher
 *    peak current, longer continuing current, usually a single stroke. It is
 *    the one that strikes well OUTSIDE the rain — the "bolt from the blue" —
 *    and it dominates in the trailing anvil of a mature or decaying storm. For
 *    a boat that is the important distinction: +CG can reach you when the cell
 *    looks like it has already passed.
 *  · Unknown — the Blitzortung network did not resolve a sign for that strike.
 *    Not a third kind of lightning; an unresolved measurement.
 */

import type { ExpressionSpecification } from 'mapbox-gl';

export type StrikePolarity = 'positive' | 'negative' | 'unknown';

export interface PolarityStyle {
    /** Legend text. */
    readonly label: string;
    /** Soft outer glow — the halo layer. */
    readonly glow: string;
    /** The crater's ember rim; the crisp ring that identifies the strike. */
    readonly rim: string;
    /** One-line plain-English meaning, for the legend's tooltip. */
    readonly meaning: string;
}

export const LIGHTNING_POLARITY: Readonly<Record<StrikePolarity, PolarityStyle>> = {
    // Hottest colour for the one that carries the most current and strikes
    // furthest from the cell.
    positive: {
        label: '+CG',
        glow: '#fb923c',
        rim: '#f97316',
        meaning: 'Positive cloud-to-ground — rarer, far higher current, can strike well outside the rain',
    },
    negative: {
        label: '−CG',
        glow: '#fbbf24',
        rim: '#f59e0b',
        meaning: 'Negative cloud-to-ground — the ordinary kind, ~90% of ground strikes',
    },
    unknown: {
        label: 'Unknown',
        glow: '#facc15',
        rim: '#fdba74',
        meaning: 'Polarity not resolved by the network — still a real ground strike',
    },
} as const;

/** Legend order: commonest first is misleading here — the dangerous one leads. */
export const POLARITY_ORDER: readonly StrikePolarity[] = ['positive', 'negative', 'unknown'] as const;

/** A Mapbox `match` expression over the `pol` property, for any style field. */
export function polarityMatch(field: 'glow' | 'rim'): ExpressionSpecification {
    return [
        'match',
        ['get', 'pol'],
        'positive',
        LIGHTNING_POLARITY.positive[field],
        'negative',
        LIGHTNING_POLARITY.negative[field],
        /* unknown — the match expression's required default */
        LIGHTNING_POLARITY.unknown[field],
    ];
}
