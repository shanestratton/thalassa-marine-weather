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

describe('short viewports (iPhone SE / 8 at 667pt)', () => {
    // On a 667pt phone the untrimmed stack left TWELVE pixels for the hero:
    // 667 - inset(20) - expandedTop(427) - bottomNav(124) = 96 container,
    // minus the 76px rain card and the gap. The tide graph, radar map and
    // instrument carousel — the entire point of The Glass — were a black
    // sliver inside an overflow-hidden box with no scroll escape, in the
    // DEFAULT first-run mode. It simply looked broken.
    const INSET = 20;
    const RAIN = 76;
    const NAV = 124;
    const heroSpace = (vh: number, mode: 'expanded' | 'collapsed') => {
        const l = getGlassTopLayout(false, vh);
        const top = mode === 'expanded' ? l.heroContainerExpandedTopPx : l.heroContainerCollapsedTopPx;
        return vh - INSET - top - NAV - RAIN - l.cardGapPx;
    };

    it('trims the chrome below 700 and leaves taller phones untouched', () => {
        expect(getGlassTopLayout(false, 667).isShortViewport).toBe(true);
        expect(getGlassTopLayout(false, 812).isShortViewport).toBe(false);
        // Omitting the height must preserve the original layout exactly, so
        // any caller that has not been updated behaves as before.
        expect(getGlassTopLayout(false)).toMatchObject(getGlassTopLayout(false, 812));
        expect(getGlassTopLayout(false).isShortViewport).toBe(false);
    });

    it('does not touch the 163px widget grid — the barometer depends on it', () => {
        // Every pixel is taken from the surrounding chrome. The widget cell is
        // a hard constraint: the barometer screen opens in place inside it.
        const tall = getGlassTopLayout(false, 812);
        const short = getGlassTopLayout(false, 667);
        expect(tall.heroContainerExpandedTopPx - tall.primaryCardTopPx).toBe(
            GLASS_HERO_WIDGETS_OUTER_HEIGHT_PX + tall.cardGapPx,
        );
        expect(short.heroContainerExpandedTopPx - short.primaryCardTopPx).toBe(
            GLASS_HERO_WIDGETS_OUTER_HEIGHT_PX + short.cardGapPx,
        );
    });

    it('gives the hero real space back on a 667pt screen', () => {
        // Essential mode becomes genuinely usable; full mode is still tight,
        // which is why Dashboard lets the container SCROLL when short rather
        // than clipping. The regression this guards is the 12px sliver.
        expect(heroSpace(667, 'collapsed')).toBeGreaterThanOrEqual(140);
        expect(heroSpace(667, 'expanded')).toBeGreaterThan(60);
    });

    it('is a no-op on tall phones — no regression to the shipped rhythm', () => {
        expect(heroSpace(812, 'expanded')).toBe(157);
        expect(heroSpace(852, 'expanded')).toBe(197);
        expect(getGlassTopLayout(false, 812).cardGapPx).toBe(GLASS_TOP_CARD_GAP_PX);
    });
});
