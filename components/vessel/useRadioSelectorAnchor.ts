import { useLayoutEffect, useRef, useState } from 'react';
import { usePaneScope } from '../../context/PanePortalContext';

export interface RadioSelectorAnchor {
    top: number;
    left: number;
    width: number;
    /** The console starts below the real app header; keep that header visible. */
    dialogTop?: number;
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
            const page = selector.closest('[data-testid="radio-console-page"]')?.getBoundingClientRect();
            const next = {
                top: rect.top - (origin?.top ?? 0),
                left: rect.left - (origin?.left ?? 0),
                width: rect.width,
                ...(page ? { dialogTop: Math.max(0, page.top - (origin?.top ?? 0)) } : {}),
            };
            setAnchor((previous) =>
                previous &&
                Math.abs(previous.top - next.top) < 0.1 &&
                Math.abs(previous.left - next.left) < 0.1 &&
                Math.abs(previous.width - next.width) < 0.1 &&
                previous.dialogTop === next.dialogTop
                    ? previous
                    : next,
            );
        };
        const followLayout = () => {
            if (!active) return;
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
        // PageTransition stages its off-screen pose before starting a CSS
        // transition two frames later. That pose has no running animation,
        // and changing transform does not notify ResizeObserver. Follow the
        // ancestor's style/phase lifecycle as well, including its final idle
        // pose, so a portal cannot retain the off-screen measurement.
        const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(followLayout);
        ancestors.forEach((element) =>
            mutations?.observe(element, {
                attributes: true,
                attributeFilter: ['class', 'style', 'data-transition-phase'],
            }),
        );
        const onTransition = (event: Event) => {
            if (event.target instanceof HTMLElement && ancestors.includes(event.target)) followLayout();
        };
        followLayout();
        window.addEventListener('resize', followLayout);
        window.addEventListener('orientationchange', followLayout);
        window.addEventListener('scroll', followLayout, true);
        document.addEventListener('animationstart', followLayout, true);
        document.addEventListener('animationend', followLayout, true);
        document.addEventListener('transitionrun', onTransition, true);
        document.addEventListener('transitionend', onTransition, true);
        document.addEventListener('transitioncancel', onTransition, true);
        window.visualViewport?.addEventListener('resize', followLayout);
        void document.fonts?.ready.then(() => {
            if (active) followLayout();
        });
        return () => {
            active = false;
            cancelAnimationFrame(frame);
            observer?.disconnect();
            mutations?.disconnect();
            window.removeEventListener('resize', followLayout);
            window.removeEventListener('orientationchange', followLayout);
            window.removeEventListener('scroll', followLayout, true);
            document.removeEventListener('animationstart', followLayout, true);
            document.removeEventListener('animationend', followLayout, true);
            document.removeEventListener('transitionrun', onTransition, true);
            document.removeEventListener('transitionend', onTransition, true);
            document.removeEventListener('transitioncancel', onTransition, true);
            window.visualViewport?.removeEventListener('resize', followLayout);
        };
    }, [pane]);

    return { selectorRef, anchor };
}
