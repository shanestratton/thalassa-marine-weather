/**
 * Thalassa Type Scale — Single Source of Truth
 *
 * 2 font families:
 *   - Inter: All UI text (labels, headers, body, buttons)
 *   - JetBrains Mono: Data values and technical readouts only
 *
 * ACCESSIBILITY: 11px floor for all text (WCAG 1.4.4 Resize Text).
 * The only exception is SVG <text> inside fixed viewBox elements
 * where the viewBox itself scales with the container.
 *
 * Named sizes (mobile-first, px-based for inline styles):
 *   - xs:      11px — unit suffixes, tertiary annotations
 *   - caption: 12px — labels, status pills, captions
 *   - body:    13px — default body text
 *   - subhead: 14px — card subheadings, data values
 *   - title:   16px — section titles, prominent data
 *   - display: 20px — hero numbers, large headings
 *   - hero:    24px — single focal numbers (cost score, etc.)
 */

// ── Font Stacks ────────────────────────────────────────────────────
export const FONT = {
    /** UI font: labels, headers, body, buttons */
    ui: "'Inter', system-ui, -apple-system, sans-serif",
    /** Data font: numbers, readouts, coordinates */
    data: "'JetBrains Mono', ui-monospace, monospace",
} as const;

// ── Type Scale ─────────────────────────────────────────────────────
// Floor: 11px. No text below this for accessibility.
export const SIZE = {
    xs: 11,    // Unit suffixes ("NM", "kts"), tertiary info
    caption: 12,    // Labels, status pills
    body: 13,    // Default body text
    subhead: 14,    // Card subheadings, data values
    title: 16,    // Section titles, prominent data
    display: 20,    // Hero numbers, large headings
    hero: 24,    // Single focal numbers (cost score, etc.)
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
