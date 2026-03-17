/**
 * OfflineTileControl — leaflet.offline integration for cached base map tiles.
 *
 * Adds a "Save Tiles" / "Remove Tiles" button to the Leaflet map.
 * Uses leaflet.offline's saveTiles control to download visible tiles
 * into IndexedDB for offline use.
 *
 * Usage:
 *   <OfflineTileControl map={leafletMap} tileLayer={tileLayerRef} />
 */

import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import { toast } from '../Toast';

// leaflet.offline extends L.TileLayer — import for side effects
import 'leaflet.offline';

interface OfflineTileControlProps {
    /** The parent Leaflet map instance */
    map: L.Map | null;
    /** The tile layer to cache tiles from */
    tileLayer: L.TileLayer | null;
}

export const OfflineTileControl: React.FC<OfflineTileControlProps> = ({ map, tileLayer }) => {
    const controlRef = useRef<L.Control | null>(null);

    useEffect(() => {
        if (!map || !tileLayer) return;

        // leaflet.offline adds L.control.savetiles
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const savetiles = (L.control as any).savetiles(tileLayer, {
            zoomlevels: [3, 4, 5, 6, 7, 8, 9, 10],
            position: 'topright',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            confirm(layer: any, successCallback: () => void) {
                const tileCount = layer._tilesforSave?.length || 0;
                toast.info(`Downloading ${tileCount} tiles for offline use…`);
                successCallback();
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            confirmRemoval(_layer: any, successCallback: () => void) {
                successCallback();
                toast.success('Cached tiles removed');
            },
            saveText: '💾 Save Tiles',
            rmText: '🗑️ Clear Cache',
        });

        savetiles.addTo(map);
        controlRef.current = savetiles;

        // Listen for save/load events
        let totalTiles = 0;
        let savedTiles = 0;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tileLayer.on('savestart', (e: any) => {
            totalTiles = e._tilesforSave?.length || 0;
            savedTiles = 0;
        });

        tileLayer.on('savetileend', () => {
            savedTiles++;
            if (savedTiles === totalTiles) {
                toast.success(`${savedTiles} tiles saved for offline use`);
            }
        });

        tileLayer.on('loadend', () => {});

        tileLayer.on('tilesremoved', () => {});

        return () => {
            if (controlRef.current && map) {
                map.removeControl(controlRef.current);
                controlRef.current = null;
            }
        };
    }, [map, tileLayer]);

    return null;
};
