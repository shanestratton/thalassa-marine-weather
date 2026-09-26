/**
 * Toast placement (UX scorecard run 6): top toasts sat on the brand header
 * and the breadcrumb/back row for 3–4 s. The stack now starts below the
 * page's own header, and falls back to the old safe-area top while a dialog
 * is open (the dim already covers the header there).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureToastAnchor } from '../components/Toast';

vi.mock('../styles/typeScale', () => ({
    FONT: { ui: 'system-ui' },
    SIZE: { subhead: 15, body: 16 },
}));

function mount(html: string) {
    document.body.innerHTML = html;
}

function placeAt(selector: string, top: number, bottom: number) {
    const el = document.querySelector(selector) as HTMLElement;
    el.getBoundingClientRect = () =>
        ({ top, bottom, left: 0, right: 390, width: 390, height: bottom - top, x: 0, y: top }) as DOMRect;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('measureToastAnchor', () => {
    it('anchors below the lowest top header on screen (brand row, then the page header)', () => {
        mount('<header id="brand"></header><div id="page" data-page-header></div>');
        placeAt('#brand', 0, 88);
        placeAt('#page', 96, 196);
        expect(measureToastAnchor()).toBe(196);
    });

    it('ignores headers that are hidden or sit low on the screen', () => {
        mount('<header id="brand"></header><div id="hidden" data-page-header></div><header id="card"></header>');
        placeAt('#brand', 0, 88);
        // #hidden keeps jsdom's zero rect (display:none / unmounted pane).
        placeAt('#card', window.innerHeight * 0.6, window.innerHeight * 0.7);
        expect(measureToastAnchor()).toBe(88);
    });

    it('keeps the old top while a dialog is open', () => {
        mount('<div id="page" data-page-header></div><div id="dlg" role="dialog" aria-modal="true"></div>');
        placeAt('#page', 96, 196);
        placeAt('#dlg', 200, 600);
        expect(measureToastAnchor()).toBe(0);
    });

    it('keeps the old top when no header is on screen (the chart)', () => {
        mount('<main></main>');
        expect(measureToastAnchor()).toBe(0);
    });
});
