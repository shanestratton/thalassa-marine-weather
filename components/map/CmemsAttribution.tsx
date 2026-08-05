/**
 * Mandatory attribution for the CMEMS-derived map layers currently visible.
 * Product metadata is sourced from the official Copernicus Marine catalogue.
 */
import React from 'react';

export type CmemsLayerId = 'currents' | 'waves' | 'sst' | 'chl' | 'seaice' | 'mld';

interface CmemsAttributionProps {
    layers: readonly CmemsLayerId[];
    embedded?: boolean;
}

const LAYER_LABELS: Record<CmemsLayerId, string> = {
    currents: 'Currents',
    waves: 'Waves',
    sst: 'Sea temperature',
    chl: 'Chlorophyll',
    seaice: 'Sea ice',
    mld: 'Mixed-layer depth',
};

const LAYER_ORDER: readonly CmemsLayerId[] = ['currents', 'waves', 'sst', 'chl', 'seaice', 'mld'];

export const CMEMS_PRODUCT_ATTRIBUTIONS = [
    {
        id: 'physics',
        label: 'Global Ocean Physics Analysis and Forecast',
        shortLabel: 'Physics',
        doi: '10.48670/moi-00016',
        layers: ['currents', 'sst', 'seaice', 'mld'] as const,
    },
    {
        id: 'waves',
        label: 'Global Ocean Waves Analysis and Forecast',
        shortLabel: 'Waves',
        doi: '10.48670/moi-00017',
        layers: ['waves'] as const,
    },
    {
        id: 'biogeochemistry',
        label: 'Global Ocean Biogeochemistry Analysis and Forecast',
        shortLabel: 'Biogeochemistry',
        doi: '10.48670/moi-00015',
        layers: ['chl'] as const,
    },
] as const;

export const CmemsAttribution: React.FC<CmemsAttributionProps> = ({ layers, embedded = false }) => {
    const requestedLayers = new Set(layers);
    const activeLayers = LAYER_ORDER.filter((layer) => requestedLayers.has(layer));
    if (activeLayers.length === 0) return null;

    const activeProducts = CMEMS_PRODUCT_ATTRIBUTIONS.filter((product) =>
        product.layers.some((layer) => requestedLayers.has(layer)),
    );
    const activeLayerLabel = activeLayers.map((layer) => LAYER_LABELS[layer]).join(', ');

    return (
        <aside
            className="absolute left-2 z-[520] max-w-[min(360px,calc(100vw-1rem))] pointer-events-auto"
            style={{
                bottom: embedded ? '84px' : 'calc(156px + env(safe-area-inset-bottom))',
            }}
            aria-label={`Copernicus Marine data attribution for ${activeLayerLabel}`}
        >
            <div className="rounded-lg border border-cyan-400/30 bg-black/70 px-2 py-1 text-[10px] leading-tight text-cyan-50/85 shadow-lg backdrop-blur-sm">
                <div className="font-semibold text-cyan-200">E.U. Copernicus Marine Service Information</div>
                <div className="mt-0.5 text-cyan-50/80">{activeLayerLabel}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {activeProducts.map((product) => (
                        <a
                            key={product.id}
                            href={`https://doi.org/${product.doi}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            referrerPolicy="no-referrer"
                            title={product.label}
                            className="rounded-sm underline underline-offset-2 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                            aria-label={`${product.label}, DOI ${product.doi}`}
                        >
                            {product.shortLabel} DOI {product.doi}
                        </a>
                    ))}
                    <span>© Mercator Ocean International</span>
                </div>
            </div>
        </aside>
    );
};
