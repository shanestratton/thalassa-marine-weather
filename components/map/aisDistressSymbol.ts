/**
 * The chart's distress-beacon symbol (build 125, package 125-02): the IEC 62288
 * AIS-SART mark, a circle with a cross (⊗), for AIS-SART, AIS man-overboard
 * and EPIRB-AIS beacons alike. Drawn white and registered as an SDF image, so
 * the AIS layer's own icon-color paints it: red active, green test, amber
 * caution (aisPresentationPalette.ts). Upright, never a boat or a dot, never
 * faded with age (the label carries the age), and never hidden by a filter.
 *
 * Shared by components/map/useMapInit.ts and the browser fixtures that render
 * it for real (e2e/fixtures/distress-beacon.tsx, chart-orientation.tsx).
 */

export const AIS_DISTRESS_ICON = 'ais-sart';
/** Pixels square, the size of the AIS boat image. */
export const AIS_DISTRESS_ICON_PX = 48;

/** The AIS target layer's icon-image: motion picks boat or dot, a beacon is always the beacon. */
export const AIS_TARGET_ICON_IMAGE = [
    'match',
    ['coalesce', ['get', 'iconKind'], 'boat'],
    'dot',
    'ais-stopped',
    'sart',
    AIS_DISTRESS_ICON,
    'ais-boat',
] as const;

const IS_BEACON = ['==', ['get', 'iconKind'], 'sart'] as const;

/** icon-size: the boat's ramp, with a beacon a size up when zoomed out so it reads from afar. */
export const AIS_TARGET_ICON_SIZE = [
    'interpolate',
    ['linear'],
    ['zoom'],
    3,
    ['case', IS_BEACON, 0.45, 0.2],
    7,
    ['case', IS_BEACON, 0.55, 0.35],
    10,
    ['case', IS_BEACON, 0.65, 0.5],
    14,
    0.8,
] as const;

/** A distress beacon's own layer: upright on screen, so a turned chart never makes the ⊗ a ⊕ (127-11a). */
export const AIS_SART_LAYER = 'ais-targets-sart';

/**
 * The AIS target icons, two layers on the one 'ais-targets' source. Motion
 * picks the boat's shape (the rotated boat underway with an orientation, else
 * the dot), precomputed per target (targetPresentation in useAisStreamLayer):
 * heading first, COG only when moving, map-aligned so each boat points her
 * real way on a turned chart. A distress beacon is always the circle and
 * cross on its own layer above the boats, upright on screen as IEC 62288
 * draws it; same image, size and paint. The AIS switch, a tap and the
 * weather bubble's target test name both layers.
 */
const ICON_LAYOUT = {
    'icon-image': AIS_TARGET_ICON_IMAGE,
    'icon-size': AIS_TARGET_ICON_SIZE,
    'icon-rotate': ['coalesce', ['get', 'orientation'], 0],
    'icon-rotation-alignment': 'map',
    'icon-allow-overlap': true,
    'icon-pitch-alignment': 'map',
} as const;
const ICON_PAINT = {
    // Type colour with safety override (NUC/restricted keep their status
    // colour); statusColor is the fallback for any feature that predates the
    // presentation pass.
    'icon-color': ['coalesce', ['get', 'typeColor'], ['get', 'statusColor']],
    // Ghost ship effect: fade vessels by age (staleMinutes): fully opaque to
    // 30 min, fading to 2 h, ghostly after. A distress beacon never fades: its
    // label says its age.
    'icon-opacity': [
        'case',
        IS_BEACON,
        1,
        [
            'interpolate',
            ['linear'],
            ['coalesce', ['get', 'staleMinutes'], 0],
            0,
            1,
            30,
            0.8,
            60,
            0.5,
            120,
            0.25,
            720,
            0.15,
        ],
    ],
} as const;
export const AIS_TARGET_ICON_LAYERS = [
    {
        id: 'ais-targets-circle',
        type: 'symbol',
        source: 'ais-targets',
        filter: ['!', IS_BEACON],
        layout: ICON_LAYOUT,
        paint: ICON_PAINT,
    },
    {
        id: AIS_SART_LAYER,
        type: 'symbol',
        source: 'ais-targets',
        filter: IS_BEACON,
        layout: { ...ICON_LAYOUT, 'icon-rotate': 0, 'icon-rotation-alignment': 'viewport' },
        paint: ICON_PAINT,
    },
] as const;

/** Where the ring and the arms sit, as fractions of the image (the browser test probes these). */
export const AIS_DISTRESS_GEOMETRY = Object.freeze({ ringRadius: 0.4, armReach: 0.4 * Math.SQRT1_2, line: 0.1 });

/** Draw the circle-and-cross, white on transparent, filling a `size`-pixel square. */
export function drawAisDistressSymbol(ctx: CanvasRenderingContext2D, size: number = AIS_DISTRESS_ICON_PX): void {
    const c = size / 2;
    const g = AIS_DISTRESS_GEOMETRY;
    const arm = g.armReach * size;
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = '#ffffff';
    // Thick enough to survive the SDF edge at the smallest zoom.
    ctx.lineWidth = g.line * size;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(c, c, g.ringRadius * size, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c - arm, c - arm);
    ctx.lineTo(c + arm, c + arm);
    ctx.moveTo(c + arm, c - arm);
    ctx.lineTo(c - arm, c + arm);
    ctx.stroke();
}

/** Register the symbol on a map (once). */
export function registerAisDistressSymbol(map: {
    hasImage(id: string): boolean;
    addImage(id: string, image: ImageData, options: { sdf: boolean }): void;
}): void {
    if (map.hasImage(AIS_DISTRESS_ICON)) return;
    const canvas = document.createElement('canvas');
    canvas.width = AIS_DISTRESS_ICON_PX;
    canvas.height = AIS_DISTRESS_ICON_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawAisDistressSymbol(ctx);
    map.addImage(AIS_DISTRESS_ICON, ctx.getImageData(0, 0, AIS_DISTRESS_ICON_PX, AIS_DISTRESS_ICON_PX), { sdf: true });
}
