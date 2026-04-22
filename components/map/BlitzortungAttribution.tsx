/**
 * BlitzortungAttribution — required attribution for the Blitzortung.org
 * lightning data feed.
 *
 * Blitzortung's terms of service require visible attribution whenever
 * their data is rendered. They run a community-funded volunteer detector
 * network and ask only for credit + (for commercial use) emailed
 * permission.
 *
 * Sister to CmemsAttribution — same chip aesthetic, bottom-left of the
 * map when the lightning layer is on.
 */
import React from 'react';

interface BlitzortungAttributionProps {
    visible: boolean;
}

export const BlitzortungAttribution: React.FC<BlitzortungAttributionProps> = ({ visible }) => {
    if (!visible) return null;

    return (
        <div
            className="absolute left-2 bottom-2 z-[140] pointer-events-auto max-w-[280px]"
            role="contentinfo"
            aria-label="Lightning data attribution"
        >
            <div className="rounded-lg border border-amber-400/30 bg-black/60 backdrop-blur-sm px-2 py-1 text-[10px] leading-tight text-amber-100/80">
                <span className="font-bold text-amber-300">⚡ Lightning:</span>{' '}
                <a
                    href="https://www.blitzortung.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-amber-200"
                >
                    Blitzortung.org
                </a>{' '}
                · community detector network
            </div>
        </div>
    );
};
