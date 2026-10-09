/**
 * The Trip sheet, loaded on first use (126-16a). Two doors open it — the Plan
 * page's Trip · Legs tile and the chart's "Plot the next leg →" row — and
 * neither carries the sheet until it is tapped.
 *
 * If its chunk fails (a web deploy moved it, or the connection dropped), the
 * skipper is told in a toast and the page underneath keeps standing: never the
 * crash card, and never the whole-app reload lazyRetry does. React.lazy keeps
 * a rejected import for good, so a failure also replaces the lazy component:
 * the next tap really does try the import again, as the toast says.
 */
import React from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import { toast } from '../Toast';
import type { TripSheetProps } from './TripSheet';

export type { TripSheetProps, TripSheetStart } from './TripSheet';

const loadTripSheet = () => React.lazy(() => import('./TripSheet'));
let TripSheet = loadTripSheet();
const RENDER_NOTHING = <></>;

export const LazyTripSheet: React.FC<TripSheetProps> = (props) => {
    const onCloseRef = React.useRef(props.onClose);
    onCloseRef.current = props.onClose;
    return (
        <ErrorBoundary
            boundaryName="TripSheet"
            fallback={RENDER_NOTHING}
            onError={() => {
                TripSheet = loadTripSheet();
                toast.error("Trip · Legs didn't open. Try again in a moment.");
                onCloseRef.current();
            }}
        >
            <React.Suspense fallback={null}>
                <TripSheet {...props} />
            </React.Suspense>
        </ErrorBoundary>
    );
};
