/**
 * The chart's claims about a vessel, pinned: type colours with an honest
 * unknown, safety states overriding type, motion picking the shape, and the
 * end of the north-pointing fleet (null COG must never rotate a target).
 */
import { describe, expect, it } from 'vitest';
import { targetPresentation, typeBucketColor } from '../components/map/useAisStreamLayer';

describe('typeBucketColor', () => {
    it('buckets the familiar palette', () => {
        expect(typeBucketColor(70)).toBe('#22c55e'); // cargo
        expect(typeBucketColor(84)).toBe('#ef4444'); // tanker
        expect(typeBucketColor(60)).toBe('#3b82f6'); // passenger
        expect(typeBucketColor(30)).toBe('#f97316'); // fishing
        expect(typeBucketColor(36)).toBe('#a855f7'); // sailing
    });

    it('unknown is grey, honestly — never a guessed type', () => {
        expect(typeBucketColor(0)).toBe('#94a3b8');
        expect(typeBucketColor(99)).toBe('#94a3b8');
    });
});

describe('targetPresentation', () => {
    it('an underway ship with heading renders as a rotated boat in type colour', () => {
        const p = targetPresentation({ shipType: 70, navStatus: 0, sog: 12, heading: 78, cog: 80 });
        expect(p).toEqual({ typeColor: '#22c55e', iconKind: 'boat', orientation: 78 });
    });

    it('COG substitutes for heading only when actually moving', () => {
        const moving = targetPresentation({ shipType: 36, navStatus: 15, sog: 5, heading: 511, cog: 120 });
        expect(moving.iconKind).toBe('boat');
        expect(moving.orientation).toBe(120);
        // Drifting: same COG present, but sog ~0 — the COG is noise, no arrow.
        const drifting = targetPresentation({ shipType: 36, navStatus: 15, sog: 0.1, heading: 511, cog: 120 });
        expect(drifting.iconKind).toBe('dot');
    });

    it('the north-pointing fleet is dead: null COG never orients a target', () => {
        const p = targetPresentation({ shipType: 70, navStatus: 0, sog: 8, heading: 511, cog: null });
        expect(p.iconKind).toBe('dot'); // moving but unoriented → dot, not a north-pointing boat
    });

    it('anchored and moored vessels are dots in their type colour', () => {
        const p = targetPresentation({ shipType: 80, navStatus: 1, sog: 0, heading: 200, cog: 0 });
        expect(p.iconKind).toBe('dot');
        expect(p.typeColor).toBe('#ef4444'); // still a tanker
    });

    it('SAFETY OVERRIDES TYPE: not-under-command keeps its status colour', () => {
        const nuc = targetPresentation({ shipType: 70, navStatus: 2, sog: 3, heading: 90, cog: 90 });
        expect(nuc.typeColor).not.toBe('#22c55e'); // never a friendly cargo green
        const restricted = targetPresentation({ shipType: 70, navStatus: 3, sog: 3, heading: 90, cog: 90 });
        expect(restricted.typeColor).not.toBe('#22c55e');
    });

    it('missing everything degrades to a grey dot', () => {
        expect(targetPresentation({})).toEqual({ typeColor: '#94a3b8', iconKind: 'dot', orientation: 0 });
    });
});
