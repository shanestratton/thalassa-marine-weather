import React from 'react';
import { createPortal } from 'react-dom';

export type OverlayLayer = 'modal' | 'nested' | 'critical';

/**
 * App chrome sits at z-[900] and several map/planning tools legitimately use
 * five-digit z-index bands. Keep ordinary blocking overlays above the chrome,
 * while reserving a near-maximum layer for alarms that must outrank every
 * other in-app surface. Leave a little headroom below the CSS integer ceiling
 * for browser/dev tooling.
 */
export const OVERLAY_Z_INDEX: Record<OverlayLayer, number> = {
    modal: 1100,
    nested: 1200,
    critical: 2147483000,
};

export const OVERLAY_LAYER_CLASS: Record<OverlayLayer, string> = {
    modal: 'z-[1100]',
    nested: 'z-[1200]',
    critical: 'z-[2147483000]',
};

interface OverlayPortalProps extends React.HTMLAttributes<HTMLDivElement> {
    layer?: OverlayLayer;
}

/**
 * Full-viewport portal that escapes transformed page containers.
 *
 * During SSR there is no body to target, so the same overlay root is
 * returned inline and can be rendered without accessing the DOM.
 */
export const OverlayPortal = React.forwardRef<HTMLDivElement, OverlayPortalProps>(
    ({ layer = 'modal', className = '', children, style, ...props }, ref) => {
        const overlay = (
            <div
                ref={ref}
                data-overlay-layer={layer}
                className={`fixed inset-0 ${OVERLAY_LAYER_CLASS[layer]} ${className}`.trim()}
                style={{ ...style, zIndex: OVERLAY_Z_INDEX[layer] }}
                {...props}
            >
                {children}
            </div>
        );

        if (typeof document === 'undefined' || !document.body) return overlay;
        return createPortal(overlay, document.body);
    },
);

OverlayPortal.displayName = 'OverlayPortal';
