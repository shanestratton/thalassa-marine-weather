/**
 * Thalassa Type Scale — the inline-style mirror of index.css's type tokens
 *
 * The CSS custom properties in index.css `:root` are the source of truth
 * (--text-micro 12, --text-label 13, --text-body 14, --text-title 18,
 * --text-hero 24). This file carries the same numbers for inline styles and
 * canvas/SVG code that cannot read a CSS variable, and names which token each
 * size mirrors. It used to disagree with them (xs 11, title 16) under an
 * "11px floor" comment, a second source of truth that let new components
 * inline 11 px (UX scorecard run 10).
 *
 * 2 font families:
 *   - Inter: All UI text (labels, headers, body, buttons)
 *   - JetBrains Mono: Data values and technical readouts only
 *
 * LEGIBILITY: 12px floor for all text, the same floor as --text-micro (raised
 * from 11 on 2026-09-02: this app is read on a wet phone on a heeling deck in
 * sunlight, not at a desk). The only exception is SVG <text> inside fixed
 * viewBox elements where the viewBox itself scales with the container.
 *
 * Named sizes (px, for inline styles):
 *   - xs:      12px — unit suffixes, tertiary annotations (--text-micro)
 *   - caption: 12px — labels, status pills, captions   (--text-micro)
 *   - body:    13px — default body text                (--text-label)
 *   - subhead: 14px — card subheadings, data values    (--text-body)
 *   - title:   18px — section titles, prominent data   (--text-title)
 *   - display: 20px — hero numbers, large headings     (Tailwind text-xl)
 *   - hero:    24px — single focal numbers             (--text-hero)
 */

// ── Font Stacks ────────────────────────────────────────────────────
export const FONT = {
    /** UI font: labels, headers, body, buttons */
    ui: "'Inter', system-ui, -apple-system, sans-serif",
    /** Data font: numbers, readouts, coordinates */
    data: "'JetBrains Mono', ui-monospace, monospace",
} as const;

// ── Type Scale ─────────────────────────────────────────────────────
// Floor: 12px (--text-micro). No text below this.
export const SIZE = {
    xs: 12, // --text-micro: unit suffixes ("NM", "kts"), tertiary info
    caption: 12, // --text-micro: labels, status pills
    body: 13, // --text-label: default body text
    subhead: 14, // --text-body: card subheadings, data values
    title: 18, // --text-title: section titles, prominent data
    display: 20, // text-xl: hero numbers, large headings
    hero: 24, // --text-hero: single focal numbers (cost score, etc.)
} as const;

// ── Minimum tap target ─────────────────────────────────────────────
// Apple HIG: 44pt minimum. Android Material: 48dp.
export const TAP_TARGET = 44;

// ── Predefined Styles ──────────────────────────────────────────────

/** Label — "BRG", "WIND", "DISTANCE" */
export const LABEL_STYLE: React.CSSProperties = {
    fontFamily: FONT.ui,
    fontWeight: 500,
    fontSize: SIZE.caption,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: '#64748b',
};

/** Data readout — numbers with monospace font */
export const DATA_STYLE: React.CSSProperties = {
    fontFamily: FONT.data,
};

/** Small annotation — coordinates, timestamps, unit labels */
export const MICRO_STYLE: React.CSSProperties = {
    fontFamily: FONT.data,
    fontSize: SIZE.xs,
    color: '#e2e8f0',
};

/** Section header — "NAV COMPUTER", "TELEMETRY" */
export const HEADER_STYLE: React.CSSProperties = {
    fontFamily: FONT.ui,
    fontWeight: 700,
    fontSize: SIZE.caption,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#ffffff',
};

/** Subtle footnote — forecast info, metadata */
export const FOOTNOTE_STYLE: React.CSSProperties = {
    fontFamily: FONT.data,
    fontSize: SIZE.xs,
    color: '#64748b',
    lineHeight: 1.4,
};
