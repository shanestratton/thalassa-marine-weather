/** Expose only the real upstream APIs this runtime loads. New callers must add their real module too. */
export const leafletRuntime: Pick<
    typeof import('leaflet'),
    | 'Map'
    | 'map'
    | 'Layer'
    | 'LayerGroup'
    | 'layerGroup'
    | 'CircleMarker'
    | 'circleMarker'
    | 'TileLayer'
    | 'tileLayer'
    | 'Control'
    | 'control'
    | 'Point'
    | 'point'
    | 'LatLngBounds'
    | 'latLngBounds'
    | 'Class'
    | 'Browser'
    | 'DomUtil'
    | 'DomEvent'
    | 'Util'
>;
