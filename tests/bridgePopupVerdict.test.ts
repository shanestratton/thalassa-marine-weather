/**
 * The curated-bridge popup and icon say what the router does (Phase 2a
 * review, 2026-09-30). Part B made the router block a bridge whose clearance
 * is below the air draft plus the 1 m margin, unknown, or only an estimate,
 * and every bridge while the air draft is unset (overheadClearance
 * clearanceBlock). The popup still said "Routing is NOT gated here" for an
 * unknown clearance, and showed a green "Clears your 18.0 m air draft" for an
 * estimated 18.5 m bridge the router refuses — an invitation to hand-trace a
 * passage under it.
 */
import { describe, expect, it } from 'vitest';
import { bridgeMarkerPassable, bridgePopupHtml } from '../components/map/bridgePopup';
import type { LowBridge } from '../services/lowBridges';

const bridge = (clearanceM: number | null, estimated?: boolean): LowBridge => ({
    id: 'test-bridge',
    name: 'Test Bridge',
    clearanceM,
    ...(estimated ? { estimated } : {}),
    span: [
        [153.0, -27.0],
        [153.001, -27.0],
    ],
});
const AIR = 18;

describe('curated bridge popup and icon follow the router verdict', () => {
    it('a charted clearance at least air draft + 1 m clears, in green', () => {
        const b = bridge(19.5);
        expect(bridgeMarkerPassable(b, AIR)).toBe(true);
        expect(bridgePopupHtml(b, AIR)).toMatch(/Clears your 18\.0 m air draft/);
    });

    it('a clearance above the air draft but inside the 1 m margin blocks', () => {
        const b = bridge(18.5);
        expect(bridgeMarkerPassable(b, AIR)).toBe(false);
        const html = bridgePopupHtml(b, AIR);
        expect(html).not.toMatch(/Clears your/);
        expect(html).toMatch(/routes are blocked here/i);
        expect(html).toMatch(/1\.0 m margin/);
    });

    it('an estimated clearance is unknown: it blocks, never green', () => {
        const b = bridge(25, true);
        expect(bridgeMarkerPassable(b, AIR)).toBe(false);
        const html = bridgePopupHtml(b, AIR);
        expect(html).not.toMatch(/Clears your/);
        expect(html).toMatch(/estimate/i);
        expect(html).toMatch(/routes are blocked here/i);
    });

    it('no published clearance blocks — the popup no longer says routing is not gated', () => {
        const b = bridge(null);
        expect(bridgeMarkerPassable(b, AIR)).toBe(false);
        const html = bridgePopupHtml(b, AIR);
        expect(html).not.toMatch(/NOT gated/i);
        expect(html).toMatch(/routes are blocked here/i);
    });

    it('with the air draft unset every bridge blocks, and the popup says why', () => {
        const b = bridge(40);
        expect(bridgeMarkerPassable(b, null)).toBe(false);
        const html = bridgePopupHtml(b, null);
        expect(html).toMatch(/air draft/i);
        expect(html).toMatch(/routes are blocked here/i);
    });

    it('a too-low bridge is impassable', () => {
        const b = bridge(8);
        expect(bridgeMarkerPassable(b, AIR)).toBe(false);
        expect(bridgePopupHtml(b, AIR)).toMatch(/IMPASSABLE/);
    });
});
