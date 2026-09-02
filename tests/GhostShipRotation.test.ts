/**
 * The ghost ship must turn with its heading (audit 2026-09-02).
 *
 * Writing `style.transform = rotate(...)` on a Mapbox Marker's element does
 * nothing lasting: Mapbox owns that transform for positioning and rewrites
 * it every frame, so the ship always pointed north. Rotation has to go
 * through the Marker API. Pinned on the source because the failure is
 * invisible to a DOM assertion — the transform IS set, briefly.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('GhostShip heading', () => {
    const src = readFileSync('components/map/GhostShip.tsx', 'utf8');
    it('rotates via marker.setRotation, never via style.transform', () => {
        expect(src).toMatch(/marker\.setRotation\(result\.heading\)/);
        expect(src).not.toMatch(/style\.transform\s*=\s*`rotate/);
    });
    it('keeps the marker map-aligned so the rotation is a bearing, not a screen angle', () => {
        expect(src).toMatch(/rotationAlignment:\s*'map'/);
    });
});
