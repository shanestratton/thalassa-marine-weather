/**
 * DiaryVideo — plays a diary clip from any reference scheme.
 *
 * Mirrors DiaryPhoto: idb-video: refs resolve to a short-lived blob URL,
 * storage/public URLs pass through. `preload="metadata"` matters more here
 * than anywhere else in the app — a diary page must not pull 200MB per entry
 * just to draw a poster frame over a boat uplink.
 */
import React, { useEffect, useState } from 'react';
import { DiaryService } from '../../services/DiaryService';

interface DiaryVideoProps {
    src: string;
    className?: string;
}

export const DiaryVideo: React.FC<DiaryVideoProps> = ({ src, className }) => {
    const [resolved, setResolved] = useState<string | null>(() => (src.startsWith('blob:') ? src : null));

    useEffect(() => {
        let cancelled = false;
        if (src.startsWith('blob:')) {
            setResolved(src);
            return;
        }
        DiaryService.resolveVideoUrl(src).then((url) => {
            if (!cancelled) setResolved(url);
        });
        return () => {
            cancelled = true;
        };
    }, [src]);

    if (!resolved) return <div className={className} aria-label="Video loading" />;

    return (
        <video
            src={resolved}
            controls
            playsInline
            preload="metadata"
            className={className ?? 'w-full rounded-xl bg-black'}
        />
    );
};
