import { useLayoutEffect, useRef, useState } from 'react';
import { usePaneScope } from '../../context/PanePortalContext';

export interface RadioSelectorAnchor {
    top: number;
    left: number;
    width: number;
}

/** Keep radio controls at their page coordinates when their content portals.
 * Phone pages begin below app chrome; split dialogs begin at the pane border.
 * Measure both origins rather than assuming a header height or viewport width.
 */
export function useRadioSelectorAnchor() {
    const selectorRef = useRef<HTMLDivElement>(null);
    const pane = usePaneScope();
    const [anchor, setAnchor] = useState<RadioSelectorAnchor | null>(null);

    useLayoutEffect(() => {
        const selector = selectorRef.current;
        if (!selector) return;
        const ancestors: HTMLElement[] = [];
        for (let element: HTMLElement | null = selector; element; element = element.parentElement) {
            ancestors.push(element);
        }
        let frame = 0;
        let active = true;
        const measure = () => {
            const rect = selector.getBoundingClientRect();
            if (rect.width === 0) return;
            const origin = pane?.host.getBoundingClientRect();
            const next = {
                top: rect.top - (origin?.top ?? 0),
                left: rect.left - (origin?.left ?? 0),
                width: rect.width,
            };
            setAnchor((previous) =>
                previous &&
                Math.abs(previous.top - next.top) < 0.1 &&
                Math.abs(previous.left - next.left) < 0.1 &&
                Math.abs(previous.width - next.width) < 0.1
                    ? previous
                    : next,
            );
        };
        const followLayout = () => {
            cancelAnimationFrame(frame);
            measure();
            // Page-entry transforms move a rectangle without resizing it.
            if (
                ancestors.some((element) =>
                    element.getAnimations?.().some((animation) => animation.playState === 'running'),
                )
            ) {
                frame = requestAnimationFrame(followLayout);
            }
        };
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(followLayout);
        ancestors.forEach((element) => observer?.observe(element));
        if (pane) observer?.observe(pane.host);
        followLayout();
        window.addEventListener('resize', followLayout);
        window.addEventListener('orientationchange', followLayout);
        window.addEventListener('scroll', followLayout, true);
        document.addEventListener('animationstart', followLayout, true);
        document.addEventListener('animationend', followLayout, true);
        window.visualViewport?.addEventListener('resize', followLayout);
        void document.fonts?.ready.then(() => {
            if (active) followLayout();
        });
        return () => {
            active = false;
            cancelAnimationFrame(frame);
            observer?.disconnect();
            window.removeEventListener('resize', followLayout);
            window.removeEventListener('orientationchange', followLayout);
            window.removeEventListener('scroll', followLayout, true);
            document.removeEventListener('animationstart', followLayout, true);
            document.removeEventListener('animationend', followLayout, true);
            window.visualViewport?.removeEventListener('resize', followLayout);
        };
    }, [pane]);

    return { selectorRef, anchor };
}
