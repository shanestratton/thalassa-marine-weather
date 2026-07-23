import { CompassIcon } from '../Icons';

export interface PinDirectionsCtaProps {
    visible: boolean;
    busy: boolean;
    error: string | null;
    onRequest: () => void;
}

export function PinDirectionsCta({ visible, busy, error, onRequest }: PinDirectionsCtaProps) {
    if (!visible) return null;

    return (
        <div className="absolute left-4 right-4 bottom-[calc(env(safe-area-inset-bottom)+88px)] z-[700] space-y-2 pointer-events-none">
            {error && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/90 backdrop-blur-md px-3 py-2 text-xs text-white shadow-lg pointer-events-auto">
                    {error}
                </div>
            )}
            <button
                onClick={onRequest}
                disabled={busy}
                aria-label="Get driving directions to pin"
                className="pointer-events-auto w-full h-12 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:scale-[0.98] transition-all text-white font-bold flex items-center justify-center gap-2 disabled:opacity-50 shadow-2xl"
            >
                {busy ? (
                    <>
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        <span>Routing…</span>
                    </>
                ) : (
                    <>
                        <CompassIcon className="w-5 h-5" rotation={0} />
                        <span>Get Directions</span>
                    </>
                )}
            </button>
        </div>
    );
}
