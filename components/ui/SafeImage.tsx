import React from 'react';
import { safeImageUrl } from '../../utils/safeUrl';

export interface SafeImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src' | 'referrerPolicy'> {
    src: unknown;
    fallback?: React.ReactNode;
    allowLocalNetworkHttp?: boolean;
}

/**
 * Privacy-safe image boundary for user, API, and third-party URLs.
 *
 * Remote images are limited to credential-free HTTPS, offline raster data
 * URLs and same-origin blob/local assets. Referrers are never sent. Lazy,
 * asynchronous decoding is the default; above-the-fold callers can opt into
 * eager loading explicitly.
 */
export const SafeImage = React.forwardRef<HTMLImageElement, SafeImageProps>(
    (
        {
            src,
            fallback = null,
            allowLocalNetworkHttp = false,
            loading = 'lazy',
            decoding = 'async',
            alt = '',
            ...props
        },
        ref,
    ) => {
        const runtimeOrigin = typeof window !== 'undefined' && window.location ? window.location.href : undefined;
        // Local Supabase/storage emulators run on a different loopback port
        // during Vite development. Production remains opt-in so untrusted
        // profile URLs cannot probe the skipper's LAN.
        const permitLocalNetworkHttp = allowLocalNetworkHttp || import.meta.env.DEV;
        const resolved = safeImageUrl(src, runtimeOrigin, {
            allowLocalNetworkHttp: permitLocalNetworkHttp,
        });

        if (!resolved) return <>{fallback}</>;

        return (
            <img
                {...props}
                ref={ref}
                src={resolved}
                alt={alt}
                loading={loading}
                decoding={decoding}
                referrerPolicy="no-referrer"
            />
        );
    },
);

SafeImage.displayName = 'SafeImage';
