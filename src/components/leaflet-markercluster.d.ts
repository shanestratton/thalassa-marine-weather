/**
 * Type declarations for leaflet.markercluster.
 *
 * We removed @types/leaflet.markercluster because it conflicted with
 * the removal of leaflet.markercluster from the main bundle. The plugin
 * is still used at runtime via a side-effect import.
 */

import 'leaflet';

declare module 'leaflet' {
    interface MarkerCluster extends Marker {
        getChildCount(): number;
    }

    interface MarkerClusterGroupOptions {
        maxClusterRadius?: number;
        spiderfyOnMaxZoom?: boolean;
        showCoverageOnHover?: boolean;
        zoomToBoundsOnClick?: boolean;
        disableClusteringAtZoom?: number;
        iconCreateFunction?: (cluster: MarkerCluster) => Icon | DivIcon;
        animate?: boolean;
        animateAddingMarkers?: boolean;
        [key: string]: unknown;
    }

    interface MarkerClusterGroup extends FeatureGroup {
        addLayers(layers: Layer[]): this;
    }

    function markerClusterGroup(options?: MarkerClusterGroupOptions): MarkerClusterGroup;
}
