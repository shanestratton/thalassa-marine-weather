/**
 * Where the issuer's label goes at the forecast track's end (129-13).
 *
 * "NHC official forecast" was drawn with text-allow-overlap, so it printed
 * over whatever was there: at zoom 2 on 14 Oct it sat under the chosen
 * place's name ("Puerto Vallarta, Mexico"). Now it takes the first of eight
 * spots around the end that is free. Mapbox keeps it off the chart's own
 * labels (its layer is placed before the base map's, and it no longer
 * overlaps), but the place pin's name and the storm's own badge are HTML
 * markers that Mapbox's placement cannot see. This orders the spots so the
 * ones clear of those markers come first.
 */

export type IssuerAnchor =
    | 'left'
    | 'right'
    | 'top'
    | 'bottom'
    | 'top-left'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-right';

/** Mapbox's anchor names the label's own side at the point: 'left' puts the words to the right of the end. */
export const ISSUER_ANCHORS: readonly IssuerAnchor[] = [
    'left',
    'right',
    'bottom',
    'top',
    'bottom-left',
    'bottom-right',
    'top-left',
    'top-right',
];

/** The layer's text-size (px) and text-radial-offset (em). */
export const ISSUER_TEXT_PX = 10;
export const ISSUER_OFFSET_EM = 0.6;

export interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** The label's size, roughly as Mapbox lays it out: 10 px type, 14 em at most a line. */
export function issuerLabelBox(text: string): { width: number; height: number } {
    const lines = String(text).split('\n');
    const longest = Math.max(1, ...lines.map((line) => [...line].length));
    const width = Math.min(longest * ISSUER_TEXT_PX * 0.6, 14 * ISSUER_TEXT_PX);
    const height = lines.length * ISSUER_TEXT_PX * 1.2 + 2;
    return { width, height };
}

/** The box the label would take with `anchor` at `point`. */
export function issuerLabelRect(
    anchor: IssuerAnchor,
    point: { x: number; y: number },
    size: { width: number; height: number },
    offsetPx = ISSUER_TEXT_PX * ISSUER_OFFSET_EM,
): Box {
    const { width: w, height: h } = size;
    const horizontal = anchor.includes('left') ? 'left' : anchor.includes('right') ? 'right' : 'centre';
    const vertical = anchor.startsWith('top') ? 'top' : anchor.startsWith('bottom') ? 'bottom' : 'centre';
    // A corner's radial offset is the same distance along the diagonal.
    const off = horizontal !== 'centre' && vertical !== 'centre' ? offsetPx / Math.SQRT2 : offsetPx;
    const left = horizontal === 'left' ? point.x + off : horizontal === 'right' ? point.x - off - w : point.x - w / 2;
    const top = vertical === 'top' ? point.y + off : vertical === 'bottom' ? point.y - off - h : point.y - h / 2;
    return { left, top, right: left + w, bottom: top + h };
}

function overlaps(a: Box, b: Box, margin: number): boolean {
    return (
        a.left < b.right + margin && a.right > b.left - margin && a.top < b.bottom + margin && a.bottom > b.top - margin
    );
}

/**
 * The eight spots, the ones clear of every obstacle first (each group in the
 * usual order). Mapbox then takes the first that is also clear of the chart's
 * own labels.
 */
export function issuerAnchorOrder(
    point: { x: number; y: number },
    size: { width: number; height: number },
    obstacles: readonly Box[],
    margin = 2,
): IssuerAnchor[] {
    const clear: IssuerAnchor[] = [];
    const blocked: IssuerAnchor[] = [];
    for (const anchor of ISSUER_ANCHORS) {
        const rect = issuerLabelRect(anchor, point, size);
        (obstacles.some((o) => overlaps(rect, o, margin)) ? blocked : clear).push(anchor);
    }
    return [...clear, ...blocked];
}
