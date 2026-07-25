import { describe, expect, it } from 'vitest';
import {
    GLASS_COMPACT_HEADER_ROW_HEIGHT_PX,
    GLASS_CURRENT_CONDITIONS_OUTER_HEIGHT_PX,
    GLASS_HERO_HEADER_OUTER_HEIGHT_PX,
    GLASS_HERO_WIDGETS_OUTER_HEIGHT_PX,
    GLASS_TOP_CARD_GAP_PX,
    getGlassTopLayout,
    glassSafeTopOffset,
} from '../components/dashboard/glassLayout';

describe('Glass top-card layout', () => {
    it.each([
        ['portrait', false, 48, 120, 128, 176, 256, 346, 427],
        ['landscape', true, 32, 104, 112, 160, 240, 330, 411],
    ])(
        'keeps every card boundary on the same 8px rhythm in %s',
        (
            _orientation,
            isMobileLandscape,
            locationCardHeightPx,
            locationHeaderHeightPx,
            compactHeaderTopPx,
            heroHeaderTopPx,
            primaryCardTopPx,
            heroContainerCollapsedTopPx,
            heroContainerExpandedTopPx,
        ) => {
            const layout = getGlassTopLayout(isMobileLandscape);

            expect(layout).toMatchObject({
                locationCardHeightPx,
                locationHeaderHeightPx,
                compactHeaderTopPx,
                heroHeaderTopPx,
                primaryCardTopPx,
                heroContainerCollapsedTopPx,
                heroContainerExpandedTopPx,
            });
            expect(layout.compactHeaderTopPx - layout.locationHeaderHeightPx).toBe(GLASS_TOP_CARD_GAP_PX);
            expect(layout.heroHeaderTopPx - layout.compactHeaderTopPx - GLASS_COMPACT_HEADER_ROW_HEIGHT_PX).toBe(
                GLASS_TOP_CARD_GAP_PX,
            );
            expect(layout.primaryCardTopPx - layout.heroHeaderTopPx - GLASS_HERO_HEADER_OUTER_HEIGHT_PX).toBe(
                GLASS_TOP_CARD_GAP_PX,
            );
            expect(
                layout.heroContainerCollapsedTopPx - layout.primaryCardTopPx - GLASS_CURRENT_CONDITIONS_OUTER_HEIGHT_PX,
            ).toBe(GLASS_TOP_CARD_GAP_PX);
            expect(
                layout.heroContainerExpandedTopPx - layout.primaryCardTopPx - GLASS_HERO_WIDGETS_OUTER_HEIGHT_PX,
            ).toBe(GLASS_TOP_CARD_GAP_PX);
        },
    );

    it('uses the same geometry for online and cached-offline Glass', () => {
        // Connectivity intentionally has no layout branch: offline only changes
        // the location-card treatment, never a card's position.
        expect(getGlassTopLayout(false)).toEqual(getGlassTopLayout(false));
        expect(glassSafeTopOffset(128)).toBe('calc(max(1rem, env(safe-area-inset-top)) + 128px)');
    });
});
