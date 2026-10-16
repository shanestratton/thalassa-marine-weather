import { lazy, Suspense, useSyncExternalStore } from 'react';
import { pendingShoreConsent, subscribeShoreConsent } from '../../services/shoreConsentLink';
const Consent = lazy(() => import('./GlobalShoreConsentGate'));
export function ShoreConsentHost() {
    const link = useSyncExternalStore(subscribeShoreConsent, pendingShoreConsent, pendingShoreConsent);
    return link ? (
        <Suspense fallback={null}>
            <Consent />
        </Suspense>
    ) : null;
}
