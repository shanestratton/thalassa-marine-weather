/**
 * Thalassa Type Scale — Single Source of Truth
 *
 * 2 font families:
 *   - Inter: All UI text (labels, headers, body, buttons)
 *   - JetBrains Mono: Data values and technical readouts only
 *
 * 6 named sizes (mobile-first, px-based for inline styles):
 *   - micro:   9px — timestamps, secondary annotations
 *   - caption: 10px — labels, status pills
 *   - body:    12px — default body text
 *   - subhead: 13px — card subheadings, data values
 *   - title:   15px — section titles, prominent data
 *   - display: 18px — hero numbers, large headings
 *   - hero:    22px — single focal numbers (cost score, etc.)
 */

// ── Font Stacks ────────────────────────────────────────────────────
export const FONT = {
    /** UI font: labels, headers, body, buttons */
    ui: "'Inter', system-ui, -apple-system, sans-serif",
    /** Data font: numbers, readouts, coordinates */
    data: "'JetBrains Mono', ui-monospace, monospace",
} as const;

// ── Type Scale ─────────────────────────────────────────────────────
export const SIZE = {
    micro: 9,
    caption: 10,
    body: 12,
    subhead: 13,
    title: 15,
    display: 18,
    hero: 22,
} as const;

// ── Predefined Styles ──────────────────────────────────────────────
// Use these for common patterns to avoid repeating fontFamily + fontSize

/** Tiny label — "BRG", "WIND", "DISTANCE" */
export const LABEL_STYLE: React.CSSProperties = {
    fontFamily: FONT.ui,
    fontWeight: 500,
    fontSize: SIZE.caption,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: '#64748b',
};

/** Data readout — numbers with monospace font */
export const DATA_STYLE: React.CSSProperties = {
    fontFamily: FONT.data,
};

/** Small annotation — coordinates, timestamps */
export const MICRO_STYLE: React.CSSProperties = {
    fontFamily: FONT.data,
    fontSize: SIZE.micro,
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
    fontSize: 8, // Exception: footnotes are intentionally tiny
    color: '#64748b',
    lineHeight: 1.4,
};
