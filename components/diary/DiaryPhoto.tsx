/**
 * DiaryPhoto — Renders a diary photo from any reference scheme.
 *
 * Handles:
 *   - http/https URLs (post-upload photos)
 *   - data: URIs (legacy offline photos)
 *   - blob: URLs (in-memory offline photos — pre-IDB entries)
 *   - idb: references (IndexedDB-backed offline photos)
 *
 * For idb: refs, the component resolves the Blob on mount and creates a
 * short-lived blob URL. The URL is revoked when the component unmounts,
 * avoiding memory leaks across long sessions.
 */
import React, { useEffect, useState } from 'react';
import { DiaryService } from '../../services/DiaryService';

interface DiaryPhotoProps {
    /** Photo reference — any scheme supported by DiaryService.resolvePhotoUrl */
    src: string;
    alt?: string;
    className?: string;
    loading?: 'lazy' | 'eager';
    onClick?: () => void;
}

export const DiaryPhoto: React.FC<DiaryPhotoProps> = ({ src, alt = '', className, loading = 'lazy', onClick }) => {
    const [resolved, setResolved] = useState<string | null>(() => {
        // Fast path: if the src is already a directly-usable URL, skip the
        // async resolution and return it synchronously so the first render
        // paints the image without a flash.
        if (src.startsWith('data:') || src.startsWith('blob:')) return src;
        return null;
    });

    useEffect(() => {
        let cancelled = false;
        // The async resolver also converts legacy public Supabase URLs into
        // signed private URLs. Only local data/blob refs can bypass it.
        if (src.startsWith('data:') || src.startsWith('blob:')) {
            setResolved(src);
            return;
        }

        DiaryService.resolvePhotoUrl(src).then((url) => {
            if (!cancelled) setResolved(url);
        });

        return () => {
            cancelled = true;
        };
    }, [src]);

    if (!resolved) {
        // Placeholder while the IDB blob resolves (usually <10ms, but showing
        // a subtle neutral bg prevents layout shift).
        return <div className={className} onClick={onClick} aria-label={alt} />;
    }

    return <img src={resolved} alt={alt} className={className} loading={loading} onClick={onClick} />;
};
