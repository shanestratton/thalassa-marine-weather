import React from 'react';
import { REVIEWS_EVENT } from '../../services/community/PlaceReviewsService';
import { reviewPlace, type ReviewPlace } from '../../services/community/placeReviewsModel';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';
const Sheet = React.lazy(() => import('./PlaceReviewsSheet'));
export default function PlaceReviewsHost() {
    const [place, setPlace] = React.useState<ReviewPlace | null>(null);
    React.useEffect(() => {
        const open = (event: Event) => {
            setPlace(reviewPlace((event as CustomEvent).detail));
        };
        window.addEventListener(REVIEWS_EVENT, open);
        const unsubscribe = subscribeAuthIdentityScope(() => setPlace(null));
        return () => {
            window.removeEventListener(REVIEWS_EVENT, open);
            unsubscribe();
        };
    }, []);
    return place ? (
        <React.Suspense fallback={null}>
            <Sheet key={place.id} place={place} onClose={() => setPlace(null)} />
        </React.Suspense>
    ) : null;
}
