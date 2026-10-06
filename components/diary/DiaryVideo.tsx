/**
 * DiaryVideo — plays a diary clip from any reference scheme.
 *
 * Mirrors DiaryPhoto: idb-video: refs resolve to a short-lived blob URL,
 * storage/public URLs pass through. `preload="metadata"` matters more here
 * than anywhere else in the app — a diary page must not pull 200MB per entry
 * just to draw a poster frame over a boat uplink.
 *
 * While the clip resolves it holds a player-sized space that says so, and if
 * the clip cannot be resolved (resolveVideoUrl gives null: not this
 * account's, gone from the device, or no way to sign it) it says that rather
 * than leaving an empty box (2026-10-06). So does a clip that resolved but
 * will not load: a signed URL cached from before the boat lost coverage, or a
 * container the webview cannot decode, left a black player with no words.
 * The words keep a 13 px floor: text-sm is 11.4 px under the fluid root font
 * at 320.
 */
import React, { useEffect, useState } from 'react';
import { DiaryService } from '../../services/DiaryService';

interface DiaryVideoProps {
    src: string;
    className?: string;
}

type Resolved = { src: string; url: string | null };

export const DiaryVideo: React.FC<DiaryVideoProps> = ({ src, className }) => {
    const [resolved, setResolved] = useState<Resolved | null>(() =>
        src.startsWith('blob:') ? { src, url: src } : null,
    );

    useEffect(() => {
        let cancelled = false;
        if (src.startsWith('blob:')) {
            setResolved({ src, url: src });
            return;
        }
        DiaryService.resolveVideoUrl(src)
            .catch(() => null)
            .then((url) => {
                if (!cancelled) setResolved({ src, url });
            });
        return () => {
            cancelled = true;
        };
    }, [src]);

    // A result for an earlier src is still loading this one.
    const current = resolved?.src === src ? resolved : null;
    if (!current?.url) {
        // A player's dark screen in every display mode, so its words keep
        // their contrast by day too.
        return (
            <div
                role="status"
                className={`flex aspect-video w-full items-center justify-center rounded-xl px-4 text-center text-[13px] font-semibold ${className ?? ''}`}
                style={{ background: '#000000', color: '#cbd5e1' }}
            >
                {current ? "This video can't be loaded right now." : 'Video loading…'}
            </div>
        );
    }

    return (
        <video
            src={current.url}
            controls
            playsInline
            preload="metadata"
            // It resolved, but will not load or decode: say so, as above.
            onError={() => setResolved((latest) => (latest?.src === src ? { src, url: null } : latest))}
            className={className ?? 'w-full rounded-xl bg-black'}
        />
    );
};
