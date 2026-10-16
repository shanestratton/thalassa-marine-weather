/** Real Leaflet 1.9.4 modules used by the remaining map/velocity consumers.
 * Keep one shared class graph for Leaflet and its plugin; the monolithic
 * CommonJS entry also registers unused GeoJSON, popups, icons and overlays.
 * All map gesture handlers, tile/vector renderers and attribution remain real.
 */
import { Map, map } from 'leaflet/src/map/index.js';
import { Layer } from 'leaflet/src/layer/Layer.js';
import { LayerGroup, layerGroup } from 'leaflet/src/layer/LayerGroup.js';
import { CircleMarker, circleMarker } from 'leaflet/src/layer/vector/CircleMarker.js';
import 'leaflet/src/layer/vector/Renderer.getRenderer.js';
import { TileLayer, tileLayer } from 'leaflet/src/layer/tile/TileLayer.js';
import { Control, control } from 'leaflet/src/control/Control.js';
import { Attribution, attribution } from 'leaflet/src/control/Control.Attribution.js';
import { Point, toPoint as point } from 'leaflet/src/geometry/Point.js';
import { LatLngBounds, toLatLngBounds as latLngBounds } from 'leaflet/src/geo/LatLngBounds.js';
import { Class } from 'leaflet/src/core/Class.js';
import Browser from 'leaflet/src/core/Browser.js';
import * as DomUtil from 'leaflet/src/dom/DomUtil.js';
import * as DomEvent from 'leaflet/src/dom/DomEvent.js';
import * as Util from 'leaflet/src/core/Util.js';
Control.Attribution = Attribution;
control.attribution = attribution;
export const leafletRuntime = {
    Map,
    map,
    Layer,
    LayerGroup,
    layerGroup,
    CircleMarker,
    circleMarker,
    TileLayer,
    tileLayer,
    Control,
    control,
    Point,
    point,
    LatLngBounds,
    latLngBounds,
    Class,
    Browser,
    DomUtil,
    DomEvent,
    Util,
};
