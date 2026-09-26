/**
 * The one corner badge for the chart's rail buttons (Systems, Layers).
 *
 * A dot says "something is on" without reading as an unread count, and both
 * buttons wear the same token so the two corners match (UX scorecard run 6).
 * The count itself belongs in the button's accessible name or inside the
 * menu it opens, never in the corner.
 */
export const CORNER_STATUS_DOT_CLASS =
    'pointer-events-none absolute -top-1 -right-1 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-slate-950';
