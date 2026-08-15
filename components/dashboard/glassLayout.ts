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
export const GLASS_LANDSCAPE_LOCATION_CARD_HEIGHT_PX = 32;

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
 * hard constraint — the barometer opens in place inside that exact cell —
 * so every pixel here comes from the surrounding chrome instead.
 */
const SHORT = {
    gap: 6,
    brandRow: 52,
    locationCard: 40,
    compactHeaderRow: 32,
    heroHeader: 56,
};

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

    const gap = isShortViewport ? SHORT.gap : GLASS_TOP_CARD_GAP_PX;
    const brandRow = isShortViewport ? SHORT.brandRow : GLASS_BRAND_ROW_HEIGHT_PX;
    const compactHeaderRow = isShortViewport ? SHORT.compactHeaderRow : GLASS_COMPACT_HEADER_ROW_HEIGHT_PX;
    const heroHeader = isShortViewport ? SHORT.heroHeader : GLASS_HERO_HEADER_OUTER_HEIGHT_PX;

    const locationCardHeightPx = isMobileLandscape
        ? GLASS_LANDSCAPE_LOCATION_CARD_HEIGHT_PX
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
    };
};

export const glassSafeTopOffset = (offsetPx: number): string => `calc(${GLASS_SAFE_TOP_CSS} + ${offsetPx}px)`;
