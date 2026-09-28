/**
 * The own-ship place-label fade, shared by its two writers.
 *
 * useVesselTracker fades the ONE base-style town name that the own-ship dot or
 * its chip prints through ("Gla◯to Stopped", UX scorecard runs 8-10). It does
 * that with a feature-state switch inside the base place layers' opacity:
 *
 *   ['case', ['boolean', ['feature-state', 'thalassaOwnshipHidden'], false], 0, <the layer's own opacity>]
 *
 * isobarLayerSetup is the only other code that writes text-opacity on those
 * layers: it hands the basemap back at 1.0 on every pass of the weather effect.
 * A plain number there dropped the switch, so the town name came back under the
 * boat, and every swap between a constant and a feature-state value re-parses
 * the whole `composite` source in mapbox-gl 3.x (StyleLayer.setPaintProperty
 * returns requiresRelayout when either side is data-driven). So an armed layer
 * is only ever written through withOwnshipLabelFade, and not at all when the
 * value is already there: an unchanged value is a no-op, not a style change.
 * The standalone pressure chart ghosts these town names through their text and
 * halo colours instead of their opacity, for the same reason (see
 * isobarLayerSetup).
 *
 * Kept free of the tracker's service imports so the weather code can use it.
 */
import type mapboxgl from 'mapbox-gl';

/** The feature-state key the base place layers' opacity reads. */
export const OWNSHIP_LABEL_STATE = 'thalassaOwnshipHidden';

export type LabelLayerIdentity = { id: string; type?: string; source?: unknown };

/** The base style's own vector sources: Mapbox `composite`, MapTiler `openmaptiles`. */
const BASE_LABEL_SOURCES: ReadonlySet<unknown> = new Set(['composite', 'openmaptiles']);

/**
 * A layer drawing town and suburb names. Never country or state names, POIs,
 * roads, water or natural features, and never island names: an island or islet
 * name is a navigational landmark, not a town (OpenMapTiles styles draw them
 * in `place` layers).
 */
export function isBasePlaceLabelLayer(layer: LabelLayerIdentity): boolean {
    if (layer.type !== 'symbol') return false;
    if (!BASE_LABEL_SOURCES.has(layer.source)) return false;
    if (/country|state|continent|poi|airport|road|water|natural|island|islet|archipelago/i.test(layer.id)) return false;
    return /settlement|place|city|town|village|hamlet|suburb|neighbou?rhood/i.test(layer.id);
}

const SETTLEMENT_KIND = /^(settlement|settlement_subdivision|city|town|village|hamlet|suburb|quarter|neighbou?rhood)$/i;

/**
 * A feature that names a settlement (Mapbox place_label class `settlement` or
 * `settlement_subdivision`; OpenMapTiles place class city, town, village,
 * hamlet, suburb, quarter or neighbourhood). Anything else, an island or islet
 * first of all, or a feature that says nothing about what it is, is left drawn.
 */
export function isSettlementPlaceFeature(properties: Record<string, unknown> | null | undefined): boolean {
    const kinds = [properties?.class, properties?.type].filter((v): v is string => typeof v === 'string');
    if (kinds.some((kind) => /island|islet|archipelago/i.test(kind))) return false;
    return kinds.some((kind) => SETTLEMENT_KIND.test(kind));
}

/** True once a paint value reads the own-ship fade state. */
export function readsOwnshipFade(value: unknown): boolean {
    return JSON.stringify(value ?? null).includes(OWNSHIP_LABEL_STATE);
}

/**
 * The layer's own opacity, but 0 for a feature in the hidden state. A zoom
 * curve keeps its zoom at the top (the spec allows data at its stops only);
 * anything this cannot wrap safely is left alone and the label stays.
 */
export function withOwnshipLabelFade(value: unknown): unknown | null {
    const hidden = ['boolean', ['feature-state', OWNSHIP_LABEL_STATE], false];
    const fade = (v: unknown) => ['case', hidden, 0, v];
    if (value === undefined || value === null) return fade(1);
    if (typeof value === 'number') return fade(value);
    if (!Array.isArray(value)) return null; // legacy {stops} function
    const text = JSON.stringify(value);
    if (text.includes(OWNSHIP_LABEL_STATE)) return value;
    if (!text.includes('"zoom"')) return fade(value);
    const zoomInput = (input: unknown) => JSON.stringify(input) === '["zoom"]';
    if (value[0] === 'interpolate' && zoomInput(value[2])) {
        return value.map((part, i) => (i >= 4 && i % 2 === 0 ? fade(part) : part));
    }
    if (value[0] === 'step' && zoomInput(value[1])) {
        return value.map((part, i) => (i >= 2 && i % 2 === 0 ? fade(part) : part));
    }
    return null;
}

/**
 * Write `value` to an armed base place layer's opacity without dropping the
 * fade, and without writing at all when it is already there. Returns false
 * when the layer is not an armed base place layer: the caller then writes its
 * plain value exactly as before.
 */
export function setOpacityKeepingOwnshipFade(
    map: mapboxgl.Map,
    layer: LabelLayerIdentity,
    property: 'text-opacity' | 'icon-opacity',
    value: number,
): boolean {
    if (!isBasePlaceLabelLayer(layer)) return false;
    const current = map.getPaintProperty(layer.id, property);
    if (!readsOwnshipFade(current)) return false;
    const next = withOwnshipLabelFade(value);
    if (JSON.stringify(next) !== JSON.stringify(current)) map.setPaintProperty(layer.id, property, next as number);
    return true;
}
