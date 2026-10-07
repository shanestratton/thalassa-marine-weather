/**
 * MapHub's share of leg reversal (Shane 2026-10-07) is wiring only; the
 * decisions are tested where they live (tripReverse, traceSave,
 * useTraceDraft, useReturnTripFlow). MapHub is too heavy to render here, so
 * this pins the wiring that would otherwise drift back: Save goes through the
 * shared decision (which carries the reversal refusal), ⇄ works on a locked
 * start, the return-trip door is handled, and the strip is on the card.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const code = readFileSync('components/map/MapHub.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function body(name: string): string {
    const start = code.indexOf(`const ${name} = useCallback(`);
    expect(start, `${name} exists`).toBeGreaterThan(-1);
    const next = code.indexOf('useCallback(', start + 40);
    return code.slice(start, next > -1 ? next : undefined);
}

describe('MapHub reverse wiring', () => {
    it('saves through the shared decision, so a reversed trip leg or followed route is refused', () => {
        const save = body('saveCurrentTrace');
        expect(save).toContain('decideTraceSave(');
        expect(save).toContain('followedSavedRouteIds(');
        expect(save).toContain("decision.kind === 'refuse'");
        expect(save).toContain('traceNameInputRef.current?.focus()');
        expect(save).toContain('commitTraceSave(decision');
        // No second, hand-rolled path to the chain writers.
        expect(save).not.toMatch(/\bsaveTrace\(|retroBadgeFirstLeg\(|healTripChain\(/);
        expect(save).toContain('returnFlowRef.current.onSaved(trace)');
    });

    it('⇄ fills a locked-start leg instead of refusing, and is enabled on the lone locked pin', () => {
        const reverse = body('reverseTrace');
        // The fill-or-copy choice is tripReverse.reverseTapDecision, tested there.
        expect(reverse).toContain('reverseTapDecision(');
        expect(reverse).not.toMatch(/\bslotCandidates\(/);
        expect(reverse).not.toContain('Chained leg — the start is locked');
        expect(code).toMatch(/onClick=\{reverseTrace\}\s*disabled=\{capturedCoords\.length < 2 && !legAnchor\}/);
    });

    it('a saved chained leg flips into a copy and drops its lock; it never fills its own slot', () => {
        const reverse = body('reverseTrace');
        expect(reverse).toContain('reverseDirection(tap.source?.label, { detach: tap.detach })');
        expect(reverse).toContain("tap.kind === 'slot-taken'");
        // A chooser left open across a Save cannot fill the now-saved slot.
        expect(body('fillReversedSlot')).toContain('legInSlot(');
        expect(code).toMatch(/aria-label=\{\s*fillsLockedSlot\s*\?/);
    });

    it('opens the trip home from the Trip · Legs door and shows the strip on the card', () => {
        expect(code).toContain("action?.kind === 'return-trip'");
        expect(code).toContain('returnFlowRef.current.start(action.tripId, action.fromOrdinal)');
        expect(code).toMatch(/<TracerReturnStrip[\s\S]*?onStopReturnTrip=\{returnFlow\.stop\}/);
    });
});
