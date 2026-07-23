/**
 * Pure click/popup logic extracted from EncVectorLayer (burn-down
 * 2026-07-16: "EncVectorLayer logic tests — fillDepareTideWindow, click
 * routing"). These functions ARE the wiring the map handler runs; the
 * handler itself only maps queryRenderedFeatures hits into them.
 */
import { describe, expect, it, vi } from 'vitest';

import { ENC_VEC_LAYERS } from '../../components/map/encLayerIds';
import {
    buildFeaturePopupHtml,
    buildGebcoDepthPopupBodyHtml,
    buildGebcoDepthPopupHtml,
    needsTideWindow,
    pickAreaTap,
    wireEncPopupLifecycle,
    type AreaTapHit,
} from '../../components/map/encPopup';

const hit = (layerId: string, properties: Record<string, unknown> = {}): AreaTapHit => ({ layerId, properties });

describe('pickAreaTap — area-tap precedence', () => {
    it('returns null for no hits (tap on nothing answers nothing)', () => {
        expect(pickAreaTap([])).toBeNull();
    });

    it('topmost hit answers by default', () => {
        const pick = pickAreaTap([hit(ENC_VEC_LAYERS.DEPARE, { DRVAL1: 2 }), hit(ENC_VEC_LAYERS.LNDARE)]);
        expect(pick).toEqual({ index: 0, cautionsUnder: [] });
    });

    it('caution wash over charted water: the WATER answers, caution rides along', () => {
        const caution = { _caution: 1, cls: 'RESARE', RESTRN: '7' };
        const pick = pickAreaTap([
            hit(ENC_VEC_LAYERS.CAUTION_AREA_FILL, caution),
            hit(ENC_VEC_LAYERS.DEPARE, { DRVAL1: 5 }),
        ]);
        expect(pick?.index).toBe(1);
        expect(pick?.cautionsUnder).toEqual([caution]);
    });

    it('STACKED caution washes ALL fold in (closing audit: only the first rode along)', () => {
        const resare = { _caution: 'RESARE', RESTRN: '7' };
        const cblare = { _caution: 'CBLARE' };
        const pick = pickAreaTap([
            hit(ENC_VEC_LAYERS.CAUTION_AREA_FILL, resare),
            hit(ENC_VEC_LAYERS.CAUTION_AREA_FILL, cblare),
            hit(ENC_VEC_LAYERS.DEPARE, { DRVAL1: 5 }),
        ]);
        expect(pick?.index).toBe(2);
        expect(pick?.cautionsUnder).toEqual([resare, cblare]);
    });

    it('caution wash with water deeper in the stack still finds it', () => {
        const pick = pickAreaTap([
            hit(ENC_VEC_LAYERS.CAUTION_AREA_FILL, { cls: 'ACHARE' }),
            hit(ENC_VEC_LAYERS.LNDARE),
            hit(ENC_VEC_LAYERS.DEPARE, { DRVAL1: 3 }),
        ]);
        expect(pick?.index).toBe(2);
        expect(pick?.cautionsUnder).toEqual([{ cls: 'ACHARE' }]);
    });

    it('caution wash with NO water beneath answers as the caution itself', () => {
        const pick = pickAreaTap([hit(ENC_VEC_LAYERS.CAUTION_AREA_FILL, { cls: 'CTNARE' })]);
        expect(pick).toEqual({ index: 0, cautionsUnder: [] });
    });

    it('water on TOP of a caution needs no fold — topmost already answers', () => {
        // The fold-in only rescues a caution-first stack; water-first keeps
        // the plain path (the caution is invisible to the popup, by design —
        // it did not intercept the tap).
        const pick = pickAreaTap([
            hit(ENC_VEC_LAYERS.DEPARE, { DRVAL1: 8 }),
            hit(ENC_VEC_LAYERS.CAUTION_AREA_FILL, { cls: 'RESARE' }),
        ]);
        expect(pick).toEqual({ index: 0, cautionsUnder: [] });
    });
});

describe('needsTideWindow — DEPARE tide-window fetch gate', () => {
    it('fires for a keel-limited band with no live tide', () => {
        expect(needsTideWindow(1.5, 2.5, null)).toBe(true);
        expect(needsTideWindow(1.5, 2.5, undefined)).toBe(true);
    });

    it('drying bank (negative DRVAL1) below safety depth fires', () => {
        expect(needsTideWindow(-0.5, 2.5, null)).toBe(true);
    });

    it('band at or above safety depth never fires', () => {
        expect(needsTideWindow(2.5, 2.5, null)).toBe(false);
        expect(needsTideWindow(10, 2.5, null)).toBe(false);
    });

    it('live tide already clearing the keel suppresses the fetch', () => {
        // 1.5 m band + 1.2 m tide = 2.7 ≥ 2.5 safety — floating right now.
        expect(needsTideWindow(1.5, 2.5, 1.2)).toBe(false);
        // Boundary: exactly clearing counts as clear.
        expect(needsTideWindow(1.5, 2.5, 1.0)).toBe(false);
    });

    it('live tide NOT clearing the keel still fires', () => {
        expect(needsTideWindow(1.5, 2.5, 0.5)).toBe(true);
        // Negative tide (below datum) can never rescue a shallow band.
        expect(needsTideWindow(1.5, 2.5, -0.3)).toBe(true);
    });

    it('unknown or missing DRVAL1 never fires', () => {
        expect(needsTideWindow(undefined, 2.5, null)).toBe(false);
        expect(needsTideWindow('not-a-depth', 2.5, null)).toBe(false);
        expect(needsTideWindow(NaN, 2.5, null)).toBe(false);
    });

    it('no safety depth (no vessel context) never fires', () => {
        expect(needsTideWindow(1.5, null, null)).toBe(false);
        expect(needsTideWindow(1.5, undefined, null)).toBe(false);
        expect(needsTideWindow(1.5, 0, null)).toBe(false);
        expect(needsTideWindow(1.5, -1, null)).toBe(false);
    });

    it('numeric-string DRVAL1 (vector-tile property) coerces', () => {
        expect(needsTideWindow('1.5', 2.5, null)).toBe(true);
    });
});

describe('buildGebcoDepthPopupHtml — uncharted-water tap answer (cycle-4 audit #6)', () => {
    it('loading phase shows a "checking" placeholder and NO chart-verified caveat yet', () => {
        const html = buildGebcoDepthPopupHtml(null, 2.9, 'loading');
        expect(html).toContain('Uncharted water');
        expect(html).toContain('checking');
        expect(html).not.toContain('NOT chart-verified');
    });

    it('a deep GEBCO reading reads deeper-than-safety-depth + the loud caveat', () => {
        const html = buildGebcoDepthPopupHtml(-12, 2.9, 'ready');
        expect(html).toContain('~12 m');
        expect(html).toContain('deeper than your 2.9 m safety depth');
        expect(html).toContain('NOT chart-verified');
        expect(html).toContain('460 m GEBCO');
    });

    it('a shallow GEBCO reading flags SHALLOWER-than-safety-depth caution', () => {
        const html = buildGebcoDepthPopupHtml(-1.5, 2.9, 'ready');
        expect(html).toContain('~2 m'); // 1.5 rounds to 2 for display
        expect(html).toContain('SHALLOWER than your 2.9 m safety depth');
        expect(html).toContain('caution');
    });

    it('a positive reading reads as land / above sea level', () => {
        expect(buildGebcoDepthPopupHtml(5, 2.9, 'ready')).toContain('land / above sea level');
    });

    it('null depth on ready = no data here (GEBCO unavailable)', () => {
        expect(buildGebcoDepthPopupHtml(null, 2.9, 'ready')).toContain('no data here');
    });

    it('omits the keel read when no vessel safety depth is known', () => {
        const html = buildGebcoDepthPopupHtml(-8, undefined, 'ready');
        expect(html).toContain('~8 m');
        expect(html).not.toContain('safety depth');
    });

    it('carries the draft-assumed caveat when the default draft is used (audit #5)', () => {
        expect(buildGebcoDepthPopupHtml(-1.5, 2.9, 'ready', true)).toContain('default 2.5 m draft');
        // A real vessel draft set → no draft caveat; the defaulted 4th arg is backward-compatible.
        expect(buildGebcoDepthPopupHtml(-1.5, 2.9, 'ready', false)).not.toContain('default 2.5 m draft');
        expect(buildGebcoDepthPopupHtml(-1.5, 2.9, 'ready')).not.toContain('default 2.5 m draft');
    });

    it('keeps one labelled non-modal dialog and a polite busy result region', () => {
        const loading = buildGebcoDepthPopupHtml(null, 2.9, 'loading');
        expect(loading).toContain('role="dialog"');
        expect(loading).toContain('aria-label="Uncharted water"');
        expect(loading).toContain('type="button"');
        expect(loading).toContain('aria-live="polite"');
        expect(loading).toContain('aria-atomic="true"');
        expect(loading).toContain('aria-busy="true"');

        expect(buildGebcoDepthPopupBodyHtml(-12, 2.9, 'ready')).toContain('~12 m');
        expect(buildGebcoDepthPopupHtml(-12, 2.9, 'ready')).toContain('aria-busy="false"');
    });
});

describe('buildFeaturePopupHtml — chart-currency caveat on provenance (re-audit UX #8)', () => {
    const depareProps = { _cellId: 'AU5TEST', _sourceHO: 'AU', DRVAL1: 5, DRVAL2: 10 };
    it('a >5 yr edition appends a verify-NtM caveat', () => {
        expect(buildFeaturePopupHtml(ENC_VEC_LAYERS.DEPARE, depareProps, { chartAgeYears: 8 })).toContain('verify NtM');
    });
    it('a fresh edition (or unknown age) adds no currency caveat', () => {
        expect(buildFeaturePopupHtml(ENC_VEC_LAYERS.DEPARE, depareProps, { chartAgeYears: 2 })).not.toContain(
            'verify NtM',
        );
        expect(buildFeaturePopupHtml(ENC_VEC_LAYERS.DEPARE, depareProps, {})).not.toContain('verify NtM');
    });

    it('emits an explicitly non-submitting close button for the non-modal dialog', () => {
        const html = buildFeaturePopupHtml(ENC_VEC_LAYERS.DEPARE, depareProps, {});
        expect(html).toContain('role="dialog"');
        expect(html).toContain('type="button"');
        expect(html).toContain('aria-label="Close"');
        expect(html).not.toContain('aria-modal');
    });
});

describe('wireEncPopupLifecycle — non-modal map popup keyboard behaviour', () => {
    const makePopup = () => {
        const container = document.createElement('div');
        container.innerHTML = '<button type="button" class="enc-popup-close">Close</button>';
        document.body.appendChild(container);
        let closeListener: (() => void) | null = null;
        const popup = {
            getElement: () => container,
            remove: vi.fn(() => {
                const listener = closeListener;
                closeListener = null;
                listener?.();
                container.remove();
            }),
            once: vi.fn((_event: 'close', listener: () => void) => {
                closeListener = listener;
            }),
        };
        return { container, popup };
    };

    it('closes on Escape, restores lost focus, and does not trap Tab', () => {
        const opener = document.createElement('button');
        opener.textContent = 'Map';
        document.body.appendChild(opener);
        const onClosed = vi.fn();
        const { container, popup } = makePopup();
        const close = container.querySelector<HTMLButtonElement>('.enc-popup-close')!;
        opener.focus();
        close.focus(); // Mapbox focusAfterOpen behaviour
        wireEncPopupLifecycle(popup, opener, onClosed);

        const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        close.dispatchEvent(tabEvent);
        expect(tabEvent.defaultPrevented).toBe(false);

        const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        close.dispatchEvent(escapeEvent);
        expect(escapeEvent.defaultPrevented).toBe(true);
        expect(popup.remove).toHaveBeenCalledOnce();
        expect(onClosed).toHaveBeenCalledOnce();
        expect(opener).toHaveFocus();
        opener.remove();
    });

    it('does not override a valid focus target outside the popup when it closes', () => {
        const opener = document.createElement('button');
        const outside = document.createElement('button');
        document.body.append(opener, outside);
        const { popup } = makePopup();
        wireEncPopupLifecycle(popup, opener);

        outside.focus();
        popup.remove();
        expect(outside).toHaveFocus();
        opener.remove();
        outside.remove();
    });
});
