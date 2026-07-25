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

export interface GlassTopLayout {
    locationCardHeightPx: number;
    locationHeaderHeightPx: number;
    compactHeaderTopPx: number;
    heroHeaderTopPx: number;
    primaryCardTopPx: number;
    heroContainerCollapsedTopPx: number;
    heroContainerExpandedTopPx: number;
}

export const getGlassTopLayout = (isMobileLandscape = false): GlassTopLayout => {
    const locationCardHeightPx = isMobileLandscape
        ? GLASS_LANDSCAPE_LOCATION_CARD_HEIGHT_PX
        : GLASS_LOCATION_CARD_HEIGHT_PX;
    const locationHeaderHeightPx = GLASS_BRAND_ROW_HEIGHT_PX + GLASS_TOP_CARD_GAP_PX + locationCardHeightPx;
    const compactHeaderTopPx = locationHeaderHeightPx + GLASS_TOP_CARD_GAP_PX;
    const heroHeaderTopPx = compactHeaderTopPx + GLASS_COMPACT_HEADER_ROW_HEIGHT_PX + GLASS_TOP_CARD_GAP_PX;
    const primaryCardTopPx = heroHeaderTopPx + GLASS_HERO_HEADER_OUTER_HEIGHT_PX + GLASS_TOP_CARD_GAP_PX;

    return {
        locationCardHeightPx,
        locationHeaderHeightPx,
        compactHeaderTopPx,
        heroHeaderTopPx,
        primaryCardTopPx,
        heroContainerCollapsedTopPx:
            primaryCardTopPx + GLASS_CURRENT_CONDITIONS_OUTER_HEIGHT_PX + GLASS_TOP_CARD_GAP_PX,
        heroContainerExpandedTopPx: primaryCardTopPx + GLASS_HERO_WIDGETS_OUTER_HEIGHT_PX + GLASS_TOP_CARD_GAP_PX,
    };
};

export const glassSafeTopOffset = (offsetPx: number): string => `calc(${GLASS_SAFE_TOP_CSS} + ${offsetPx}px)`;
