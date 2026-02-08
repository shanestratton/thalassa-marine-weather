/**
 * SafeResponsiveContainer — wraps Recharts' ResponsiveContainer to suppress
 * the "width(-1) and height(-1)" warning that fires when charts are rendered
 * in off-screen carousel slides or before the DOM has computed layout.
 *
 * Uses a two-phase check:
 *   1. After first paint (rAF + rAF), check offsetWidth/offsetHeight.
 *   2. If still zero, fall back to ResizeObserver.
 *
 * This avoids the race where getBoundingClientRect reports positive CSS sizes
 * but Recharts' internal offsetWidth/offsetHeight is still 0.
 */
import React, { useRef, useState, useEffect } from 'react';
import { ResponsiveContainer } from 'recharts';

interface SafeResponsiveContainerProps {
    width?: string | number;
    height?: string | number;
    minWidth?: number;
    minHeight?: number;
    children: React.ReactNode;
}

export const SafeResponsiveContainer: React.FC<SafeResponsiveContainerProps> = ({
    width = '100%',
    height = '100%',
    minWidth = 0,
    minHeight = 0,
    children,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [hasSize, setHasSize] = useState(false);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        let cancelled = false;
        let observer: ResizeObserver | null = null;

        // Double-rAF ensures we check AFTER the browser has painted and layout is stable
        const rafId = requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (cancelled) return;

                // Use offsetWidth/offsetHeight — this is what Recharts uses internally
                if (el.offsetWidth > 0 && el.offsetHeight > 0) {
                    setHasSize(true);
                    return;
                }

                // Still no size — observe for layout changes (e.g. off-screen slides)
                observer = new ResizeObserver((entries) => {
                    for (const entry of entries) {
                        const { width: ew, height: eh } = entry.contentRect;
                        if (ew > 0 && eh > 0) {
                            setHasSize(true);
                            observer?.disconnect();
                            observer = null;
                            break;
                        }
                    }
                });

                observer.observe(el);
            });
        });

        return () => {
            cancelled = true;
            cancelAnimationFrame(rafId);
            observer?.disconnect();
        };
    }, []);

    return (
        <div ref={containerRef} style={{ width: typeof width === 'number' ? width : width, height: typeof height === 'number' ? height : height }}>
            {hasSize ? (
                <ResponsiveContainer width="100%" height="100%" minWidth={minWidth} minHeight={minHeight}>
                    {children as React.ReactElement}
                </ResponsiveContainer>
            ) : null}
        </div>
    );
};
