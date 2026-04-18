/**
 * CmemsAttribution — mandatory Copernicus Marine licence attribution chip.
 *
 * The CMEMS licence requires the service name, product DOI, and Mercator
 * Ocean copyright notice to be visible whenever CMEMS-derived data is on
 * screen. Not optional. See scripts/cmems-currents-pipeline/README.md.
 */
import React from 'react';

interface CmemsAttributionProps {
    visible: boolean;
}

// DOI of the product this attribution covers. Update when the pipeline
// switches to a different CMEMS dataset.
const PRODUCT_DOI = '10.48670/moi-00016';
const PRODUCT_DOI_URL = `https://doi.org/${PRODUCT_DOI}`;

export const CmemsAttribution: React.FC<CmemsAttributionProps> = ({ visible }) => {
    if (!visible) return null;

    return (
        <div
            className="absolute left-2 bottom-2 z-[140] pointer-events-auto max-w-[280px]"
            role="contentinfo"
            aria-label="Ocean current data attribution"
        >
            <div className="rounded-lg border border-cyan-400/30 bg-black/60 backdrop-blur-sm px-2 py-1 text-[10px] leading-tight text-cyan-100/80">
                <span className="font-bold text-cyan-300">Currents:</span> E.U. Copernicus Marine Service Information ·{' '}
                <a
                    href={PRODUCT_DOI_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-cyan-200"
                >
                    DOI
                </a>{' '}
                · © Mercator Ocean International
            </div>
        </div>
    );
};
