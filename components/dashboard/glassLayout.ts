/**
 * Shared geometry for the fixed card stack on The Glass.
 *
 * The location card lives in App.tsx while the weather cards live in
 * Dashboard.tsx. Keeping their measurements here prevents the two pieces of
 * the same visual stack from slowly drifting apart as either one changes.
 *
 * Network state is deliberately not an input: cached/offline mode may change
 * colour and icon treatment, but it must never change this card rhythm.
 */
export const GLASS_TOP_CARD_GAP_PX = 8;
export const GLASS_BRAND_ROW_HEIGHT_PX = 64;
export const GLASS_LOCATION_CARD_HEIGHT_PX = 48;
/**
 * Landscape keeps the portrait location card. index.css gives every text
 * input a 48 px min-height from 768 px wide, which an 852 x 393 phone is,
 * so a 32 px slot was fiction: the field painted 47 px, overlapped the
 * warnings row by 9 and its icon sat off-centre (UX scorecard run 6).
 */
export const GLASS_LANDSCAPE_LOCATION_CARD_HEIGHT_PX = GLASS_LOCATION_CARD_HEIGHT_PX;

// These are the rendered outer heights, including each card's border.
export const GLASS_COMPACT_HEADER_ROW_HEIGHT_PX = 40;
export const GLASS_HERO_HEADER_OUTER_HEIGHT_PX = 72;
export const GLASS_CURRENT_CONDITIONS_OUTER_HEIGHT_PX = 82;
export const GLASS_HERO_WIDGETS_OUTER_HEIGHT_PX = 163;

/** Matches App.tsx's safe-area padding, including browsers without a notch. */
export const GLASS_SAFE_TOP_CSS = 'max(1rem, env(safe-area-inset-top))';

/**
 * Below this viewport height the full-size stack cannot fit and the chrome
 * is trimmed. 700 covers the iPhone SE/8 family at 667 and leaves the 812+
 * phones on the original rhythm untouched.
 */
export const GLASS_SHORT_VIEWPORT_PX = 700;

/**
 * Trimmed chrome for short screens.
 *
 * The widget grid is DELIBERATELY ABSENT from this list. Its 163px box is a
 * hard constraint — every card below the hero is positioned from it (the
 * barometer that once opened in place inside the cell is a full modal now,
 * but the geometry the stack hangs off has not moved) — so every pixel here
 * comes from the surrounding chrome instead.
 */
const SHORT = {
    gap: 6,
    brandRow: 52,
    // 44, not 40: the location field is a tap target and must meet the floor.
    locationCard: 44,
    compactHeaderRow: 32,
    heroHeader: 56,
};

/**
 * Mobile landscape (852x393). The full rhythm is 403 px before the hero even
 * starts, so the fixed footer painted across the widget grid and four of the
 * safety numbers were unreadable in the orientation a cockpit mount ends up
 * in (UX scorecard 2026-09-25, the weakest screen at 5.1). Chrome is trimmed
 * harder than SHORT; the 163 px grid is untouched; the gap stays 8 so every
 * boundary is still on the Glass rhythm. Dashboard.tsx switches its layers
 * from `fixed` to `absolute` in landscape so the whole column scrolls.
 *
 * The trimmed slots are a contract the cards must honour: Dashboard.tsx marks
 * its root `data-glass-rhythm="landscape"` (or "short" for SHORT), so the
 * warnings row and conditions header can size themselves to 32 / 56. The
 * location card is the exception — see GLASS_LANDSCAPE_LOCATION_CARD_HEIGHT_PX.
 */
const LANDSCAPE = {
    gap: GLASS_TOP_CARD_GAP_PX,
    brandRow: 40,
    locationCard: GLASS_LANDSCAPE_LOCATION_CARD_HEIGHT_PX,
    compactHeaderRow: 32,
    heroHeader: 56,
};

/** Hero container (rain card + carousel) height in landscape, where it can no longer be bottom-anchored. */
export const GLASS_LANDSCAPE_HERO_CONTAINER_HEIGHT_PX = 300;

export interface GlassTopLayout {
    locationCardHeightPx: number;
    locationHeaderHeightPx: number;
    compactHeaderTopPx: number;
    heroHeaderTopPx: number;
    primaryCardTopPx: number;
    heroContainerCollapsedTopPx: number;
    heroContainerExpandedTopPx: number;
    /** The viewport is too short for the full rhythm; chrome has been trimmed. */
    isShortViewport: boolean;
    /** The gap actually used between cards, so callers stay in step. */
    cardGapPx: number;
    /** The brand row height in use (App.tsx sizes the row from it). */
    brandRowHeightPx: number;
    compactHeaderRowHeightPx: number;
    heroHeaderHeightPx: number;
}

/**
 * @param viewportHeightPx  Pass window.innerHeight. Omitted means "assume a
 *   tall phone", which preserves the previous behaviour exactly.
 */
export const getGlassTopLayout = (isMobileLandscape = false, viewportHeightPx?: number): GlassTopLayout => {
    // On a 667pt phone the untrimmed stack left TWELVE pixels for the hero —
    // the tide graph, radar and instrument carousel reduced to a black sliver
    // under the rain card, inside an overflow-hidden container with no scroll
    // escape. It simply looked broken, in the default first-run mode.
    const isShortViewport = typeof viewportHeightPx === 'number' && viewportHeightPx < GLASS_SHORT_VIEWPORT_PX;

    const gap = isMobileLandscape ? LANDSCAPE.gap : isShortViewport ? SHORT.gap : GLASS_TOP_CARD_GAP_PX;
    const brandRow = isMobileLandscape
        ? LANDSCAPE.brandRow
        : isShortViewport
          ? SHORT.brandRow
          : GLASS_BRAND_ROW_HEIGHT_PX;
    const compactHeaderRow = isMobileLandscape
        ? LANDSCAPE.compactHeaderRow
        : isShortViewport
          ? SHORT.compactHeaderRow
          : GLASS_COMPACT_HEADER_ROW_HEIGHT_PX;
    const heroHeader = isMobileLandscape
        ? LANDSCAPE.heroHeader
        : isShortViewport
          ? SHORT.heroHeader
          : GLASS_HERO_HEADER_OUTER_HEIGHT_PX;

    const locationCardHeightPx = isMobileLandscape
        ? LANDSCAPE.locationCard
        : isShortViewport
          ? SHORT.locationCard
          : GLASS_LOCATION_CARD_HEIGHT_PX;

    const locationHeaderHeightPx = brandRow + gap + locationCardHeightPx;
    const compactHeaderTopPx = locationHeaderHeightPx + gap;
    const heroHeaderTopPx = compactHeaderTopPx + compactHeaderRow + gap;
    const primaryCardTopPx = heroHeaderTopPx + heroHeader + gap;

    return {
        locationCardHeightPx,
        locationHeaderHeightPx,
        compactHeaderTopPx,
        heroHeaderTopPx,
        primaryCardTopPx,
        heroContainerCollapsedTopPx: primaryCardTopPx + GLASS_CURRENT_CONDITIONS_OUTER_HEIGHT_PX + gap,
        heroContainerExpandedTopPx: primaryCardTopPx + GLASS_HERO_WIDGETS_OUTER_HEIGHT_PX + gap,
        isShortViewport,
        cardGapPx: gap,
        brandRowHeightPx: brandRow,
        compactHeaderRowHeightPx: compactHeaderRow,
        heroHeaderHeightPx: heroHeader,
    };
};

export const glassSafeTopOffset = (offsetPx: number): string => `calc(${GLASS_SAFE_TOP_CSS} + ${offsetPx}px)`;
