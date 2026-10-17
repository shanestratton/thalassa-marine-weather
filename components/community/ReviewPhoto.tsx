import React from 'react';
import { photoRequest } from '../../services/community/PlaceReviewsService';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';
export function ReviewPhoto({ id }: { id: string }) {
    const instance = React.useId();
    const [open, setOpen] = React.useState(false);
    const [url, setUrl] = React.useState<string | null>(null);
    const [message, setMessage] = React.useState('Photo requires sign-in and approval.');
    React.useEffect(() => {
        const changed = (event: Event) => {
            if ((event as CustomEvent).detail !== instance) setOpen(false);
        };
        window.addEventListener('thalassa:community-photo-open', changed);
        return () => window.removeEventListener('thalassa:community-photo-open', changed);
    }, [instance]);
    React.useEffect(() => {
        if (!open) {
            setUrl(null);
            return;
        }
        const ctl = new AbortController();
        let blobUrl: string | undefined;
        const unsubscribe = subscribeAuthIdentityScope(() => {
            ctl.abort();
            setUrl(null);
            setOpen(false);
            if (blobUrl) URL.revokeObjectURL(blobUrl);
        });
        const timer = setTimeout(() => {
            ctl.abort();
            unsubscribe();
            setUrl(null);
            setMessage('Photo expired. Refresh notes to recheck access.');
            setOpen(false);
            if (blobUrl) URL.revokeObjectURL(blobUrl);
        }, 15000);
        void photoRequest(id, ctl.signal)
            .then((r) => r.blob())
            .then((blob) => {
                if (ctl.signal.aborted) return;
                if (blob.size > 1048576 || blob.type !== 'image/jpeg') throw new Error('Photo unavailable.');
                blobUrl = URL.createObjectURL(blob);
                setUrl(blobUrl);
            })
            .catch(() => {
                if (!ctl.signal.aborted) setMessage('Photo unavailable or awaiting moderation.');
            });
        return () => {
            ctl.abort();
            unsubscribe();
            clearTimeout(timer);
            if (blobUrl) URL.revokeObjectURL(blobUrl);
        };
    }, [id, open]);
    return (
        <div className="space-y-2">
            <button
                type="button"
                className="min-h-[44px] rounded-lg border border-white/20 px-3 py-2 text-sm"
                onClick={() => {
                    window.dispatchEvent(new CustomEvent('thalassa:community-photo-open', { detail: instance }));
                    setOpen((value) => !value);
                }}
            >
                {open ? 'Close photo' : 'View photo'}
            </button>
            {url ? (
                <img
                    src={url}
                    alt="Skipper’s community photo"
                    className="max-h-48 max-w-full rounded-lg object-contain"
                    referrerPolicy="no-referrer"
                />
            ) : (
                <p className="text-xs text-slate-400">{message}</p>
            )}
        </div>
    );
}
