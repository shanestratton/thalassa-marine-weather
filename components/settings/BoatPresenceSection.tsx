import React from 'react';
const Sheet = React.lazy(() => import('../map/presence/BoatPresenceSheet'));
export function BoatPresenceSection() {
    const [open, setOpen] = React.useState(false);
    return (
        <>
            <p className="text-xs text-slate-300">
                Choose crew, accepted friends or nearby users. Off by default. All positions are rounded to 0.05° cells
                and delayed at least 5 minutes; publication starts only when you ask in Obs.
            </p>
            <button
                type="button"
                className="mt-2 min-h-[44px] w-full rounded-lg border border-white/20 px-3 py-2 text-sm text-white"
                onClick={() => setOpen(true)}
            >
                Boat presence privacy and friends
            </button>
            {open && (
                <React.Suspense fallback={<p role="status">Opening presence controls…</p>}>
                    <Sheet onClose={() => setOpen(false)} />
                </React.Suspense>
            )}
        </>
    );
}
