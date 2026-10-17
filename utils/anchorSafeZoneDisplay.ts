import { anchorZoneOffset, parseAnchorSafeZone, type AnchorZoneFrame } from './anchorSafeZone';

/** Bounded display coordinates only. The Watch must never use them as an alarm rule. */
export function anchorSafeZoneDisplay(
    value: unknown,
    frame: AnchorZoneFrame,
): {
    safeAreaOutline?: readonly (readonly [number, number])[];
    safeAreaWedges?: readonly (readonly [number, number])[];
} {
    const parsed = parseAnchorSafeZone(value, frame);
    if (!parsed.ok) return {};
    return parsed.zone.kind === 'polygon'
        ? {
              safeAreaOutline: parsed.zone.vertices.map((p) => {
                  const xy = anchorZoneOffset(frame, p)!;
                  return [xy[0] / frame.radiusM, xy[1] / frame.radiusM] as const;
              }),
          }
        : { safeAreaWedges: parsed.zone.exclusions.map((w) => [w.startDeg, w.sweepDeg] as const) };
}
