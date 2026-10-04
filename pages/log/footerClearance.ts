/**
 * Bottom clearance for the Log page's pinned controls (the "Slide to Start
 * Tracking" footer and the Stop / Share / New Entry row).
 *
 * On a phone the tab bar floats over the page, so the controls clear it: 4rem
 * plus the home-indicator inset, and 8 pt of air. In an iPad split pane the
 * frame already ends above the tab bar, and App hangs the page
 * --split-page-overhang below the frame so every page's own clearance lands at
 * the frame's edge. That put the slide flush on the pane's bottom border (Shane
 * 2026-10-04: "the cta button a little low"). In a pane the clearance is the
 * overhang plus the same 8 pt, so the slide sits as far above the pane's edge
 * as it sits above the tab bar on the iPhone.
 */
export const LOG_FOOTER_CLEARANCE = 'calc(var(--split-page-overhang, calc(4rem + env(safe-area-inset-bottom))) + 8px)';
