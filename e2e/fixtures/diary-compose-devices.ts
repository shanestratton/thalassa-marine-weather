/**
 * The screens the diary compose page must fit (Shane 2026-10-06: "could we
 * make the diary page just fit the area. I hate scrolling"). CSS px, with
 * the status bar (top) and home indicator (bottom) insets each device gives
 * the webview. The fixture (diary-compose.tsx, ?device=<key>) draws the real
 * app chrome round the form for these: the THALASSA header with its
 * max(1rem, top inset) pad, the tab bar with its bottom inset, and, for the
 * tablet, the split view's frame. Shared by the fixture and the layout spec.
 */
export interface DiaryDevice {
    name: string;
    width: number;
    height: number;
    top: number;
    bottom: number;
    /** The iPad split view: the diary in the right-hand pane. */
    pane?: boolean;
    /** A phone on its side (App.tsx isMobileLandscape): the one-row header,
     *  the tab bar folded into the bottom-left toggle. */
    landscape?: boolean;
    /** Must fit with no column scroll (320x568 may scroll as a last resort;
     *  a standard iPhone with Display Zoom, 320x693, must fit). */
    mustFit: boolean;
    /** The least the text box may give way to at rest (default 72 px, 44 px
     *  when both long notes wrap). On a 320 pt screen 44 px in every state. */
    textMin?: number;
    /** On a 320 pt screen with both long notes wrapped (no GPS fix and not
     *  looking, no recent trips: three lines more), the most the column may
     *  scroll. Every control stays whole and reachable. */
    longNotesScroll?: number;
}

export type DiaryDeviceKey =
    | 'iphone-se'
    | 'iphone-13-mini'
    | 'iphone-14'
    | 'iphone-15'
    | 'iphone-16-pro'
    | 'iphone-pro-max'
    | 'iphone-16-pro-max'
    | 'iphone-se-zoomed'
    | 'iphone-14-zoomed'
    | 'iphone-16-zoomed'
    | 'iphone-14-landscape'
    | 'tablet-pane';

export const DIARY_DEVICES: Record<DiaryDeviceKey, DiaryDevice> = {
    'iphone-se': { name: 'iPhone SE', width: 375, height: 667, top: 20, bottom: 0, mustFit: true },
    'iphone-13-mini': { name: 'iPhone 13 mini', width: 375, height: 812, top: 50, bottom: 34, mustFit: true },
    'iphone-14': { name: 'iPhone 14', width: 390, height: 844, top: 47, bottom: 34, mustFit: true },
    'iphone-15': { name: 'iPhone 15/16', width: 393, height: 852, top: 59, bottom: 34, mustFit: true },
    'iphone-16-pro': { name: 'iPhone 16 Pro', width: 402, height: 874, top: 62, bottom: 34, mustFit: true },
    'iphone-pro-max': { name: 'iPhone Pro Max', width: 430, height: 932, top: 59, bottom: 34, mustFit: true },
    'iphone-16-pro-max': { name: 'iPhone 16 Pro Max', width: 440, height: 956, top: 62, bottom: 34, mustFit: true },
    'iphone-se-zoomed': { name: 'iPhone SE zoomed', width: 320, height: 568, top: 20, bottom: 0, mustFit: false },
    // Display Zoom on a standard iPhone: the screen drawn as 320x693, the
    // insets scaled with it (47/34 at 390 wide, 59/34 at 393 and 402).
    'iphone-14-zoomed': {
        name: 'iPhone 12–14 zoomed',
        width: 320,
        height: 693,
        top: 39,
        bottom: 28,
        mustFit: true,
        textMin: 44,
        longNotesScroll: 16,
    },
    'iphone-16-zoomed': {
        name: 'iPhone 14 Pro–16 zoomed',
        width: 320,
        height: 693,
        top: 48,
        bottom: 28,
        mustFit: true,
        textMin: 44,
        longNotesScroll: 16,
    },
    // A phone on its side may scroll as a last resort; it stays usable, with
    // the keyboard up too.
    'iphone-14-landscape': {
        name: 'iPhone 14 landscape',
        width: 844,
        height: 390,
        top: 0,
        bottom: 21,
        landscape: true,
        mustFit: false,
    },
    'tablet-pane': {
        name: 'iPad split pane',
        width: 1024,
        height: 768,
        top: 24,
        bottom: 20,
        pane: true,
        mustFit: true,
    },
};
