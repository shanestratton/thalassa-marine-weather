/**
 * Toast placement (UX scorecard run 6): top toasts sat on the brand header
 * and the breadcrumb/back row for 3–4 s. The stack now starts below the
 * page's own header, and falls back to the old safe-area top while a dialog
 * is open (the dim already covers the header there).
 */
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureToastAnchor, measureToastDock, toast, ToastPortal } from '../components/Toast';

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
    cleanup();
    toast.clear();
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

// UX scorecard run 7: '40 suggested tasks added' covered the Engine hours card
// for 3–4 s. A page with a bottom action bar gets its toasts docked on the bar.
describe('measureToastDock', () => {
    const h = window.innerHeight;

    it('returns the top of a bottom action bar on screen', () => {
        mount('<button id="bar" data-toast-dock></button>');
        placeAt('#bar', h - 120, h - 64);
        expect(measureToastDock()).toBe(h - 120);
    });

    it('ignores a bar in the top half, a hidden bar, and any bar while a dialog is open', () => {
        mount('<button id="top" data-toast-dock></button><button id="hidden" data-toast-dock></button>');
        placeAt('#top', 40, 96);
        expect(measureToastDock()).toBeNull();
        mount('<button id="bar" data-toast-dock></button><div id="dlg" role="dialog"></div>');
        placeAt('#bar', h - 120, h - 64);
        placeAt('#dlg', 200, 600);
        expect(measureToastDock()).toBeNull();
    });

    it('docks the stack above the bar, and keeps the top placement without one', () => {
        const bar = document.createElement('button');
        bar.setAttribute('data-toast-dock', '');
        bar.getBoundingClientRect = () =>
            ({
                top: h - 120,
                bottom: h - 64,
                left: 0,
                right: 390,
                width: 390,
                height: 56,
                x: 0,
                y: h - 120,
            }) as DOMRect;
        document.body.appendChild(bar);
        const { container, unmount } = render(<ToastPortal />);
        act(() => {
            toast.success('40 suggested tasks added');
        });
        const stack = container.querySelector('[data-toast-stack]') as HTMLElement;
        expect(stack).toHaveAttribute('data-toast-stack', 'docked');
        expect(stack.style.bottom).toBe('128px');
        expect(stack.style.top).toBe('');
        unmount();
        bar.remove();

        const again = render(<ToastPortal />);
        act(() => {
            toast.info('Saved');
        });
        expect(again.container.querySelector('[data-toast-stack]')).toHaveAttribute('data-toast-stack', 'top');
    });
});
