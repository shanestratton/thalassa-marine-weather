import React, { useCallback, useEffect, useRef, useState } from 'react';

interface PhotoLightboxProps {
    photos: string[];
    startIndex?: number;
    /** Shown along the bottom — e.g. entry title · location. */
    caption?: string;
    onClose: () => void;
}

/** Fullscreen, swipeable photo viewer for the Voyage Log. */
export const PhotoLightbox: React.FC<PhotoLightboxProps> = ({ photos, startIndex = 0, caption, onClose }) => {
    const [index, setIndex] = useState(startIndex);
    const touchStartX = useRef<number | null>(null);

    const go = useCallback(
        (delta: number) => {
            setIndex((i) => (i + delta + photos.length) % photos.length);
        },
        [photos.length],
    );

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowLeft') go(-1);
            else if (e.key === 'ArrowRight') go(1);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [go, onClose]);

    if (photos.length === 0) return null;

    const multi = photos.length > 1;

    const handleTouchEnd = (e: React.TouchEvent) => {
        if (touchStartX.current == null) return;
        const delta = e.changedTouches[0].clientX - touchStartX.current;
        touchStartX.current = null;
        if (Math.abs(delta) > 50) go(delta < 0 ? 1 : -1);
    };

    return (
        <div
            className="fixed inset-0 z-[80] flex flex-col bg-black/95 backdrop-blur-sm"
            onClick={onClose}
            onTouchStart={(e) => {
                touchStartX.current = e.touches[0].clientX;
            }}
            onTouchEnd={handleTouchEnd}
        >
            {/* Top bar */}
            <div className="shrink-0 flex items-center justify-between px-5 py-4 text-white">
                <span className="text-xs font-mono text-slate-400">
                    {multi ? `${index + 1} / ${photos.length}` : ''}
                </span>
                <button
                    onClick={onClose}
                    aria-label="Close photo viewer"
                    className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
                >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>

            {/* Image */}
            <div className="flex-1 flex items-center justify-center min-h-0 px-4 relative">
                <img
                    src={photos[index]}
                    alt=""
                    onClick={(e) => e.stopPropagation()}
                    className="max-h-full max-w-full object-contain rounded-lg shadow-2xl select-none"
                />

                {multi && (
                    <>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                go(-1);
                            }}
                            aria-label="Previous photo"
                            className="absolute left-2 sm:left-6 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
                        >
                            <svg
                                className="w-6 h-6"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                            </svg>
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                go(1);
                            }}
                            aria-label="Next photo"
                            className="absolute right-2 sm:right-6 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
                        >
                            <svg
                                className="w-6 h-6"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                            </svg>
                        </button>
                    </>
                )}
            </div>

            {/* Caption + dots */}
            <div className="shrink-0 px-5 py-4 text-center space-y-2">
                {caption && <p className="text-sm text-slate-300">{caption}</p>}
                {multi && (
                    <div className="flex items-center justify-center gap-1.5">
                        {photos.map((_, i) => (
                            <button
                                key={i}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setIndex(i);
                                }}
                                aria-label={`Go to photo ${i + 1}`}
                                className={`h-1.5 rounded-full transition-all ${
                                    i === index ? 'w-6 bg-sky-400' : 'w-1.5 bg-white/30 hover:bg-white/50'
                                }`}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
