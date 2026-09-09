import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useKeyboardOffset } from '../hooks/useKeyboardOffset';
import { getKeyboardViewport } from '../utils/keyboardScroll';

interface PaneScope {
    id: string;
    host: HTMLDivElement;
    frameRef: React.RefObject<HTMLElement>;
    contentRef: React.RefObject<HTMLElement>;
}

export const PanePortalContext = createContext<PaneScope | null>(null);

interface PanePortalScopeProps {
    enabled: boolean;
    paneId: string;
    frameRef: React.RefObject<HTMLElement>;
    /** The kept-alive chart lives outside its measured frame. */
    contentRef?: React.RefObject<HTMLElement>;
    children: React.ReactNode;
}

/**
 * Keep page ownership in React context, even when a child opens another portal.
 * The portal host lives under body, outside page transforms and scrollers, but
 * its containing block is exactly the visible pane. Keep this provider mounted
 * when toggling split: in particular, the Mapbox subtree must never remount.
 */
export function PanePortalScope({ enabled, paneId, frameRef, contentRef = frameRef, children }: PanePortalScopeProps) {
    const [host] = useState(() => (typeof document === 'undefined' ? null : document.createElement('div')));
    const keyboardHeight = useKeyboardOffset(enabled);
    const scope = useMemo(
        () => (enabled && host ? { id: paneId, host, frameRef, contentRef } : null),
        [enabled, host, paneId, frameRef, contentRef],
    );

    useLayoutEffect(() => {
        if (!scope) return;
        host!.dataset.panePortal = paneId;
        host!.className = 'pane-portal-host';
        document.body.appendChild(host!);
        const frame = frameRef.current;
        const content = contentRef.current;
        return () => {
            host!.remove();
            for (const element of [frame, content]) {
                element?.style.removeProperty('--pane-width');
                element?.style.removeProperty('--pane-height');
            }
        };
    }, [scope, host, paneId, frameRef, contentRef]);

    useLayoutEffect(() => {
        if (!scope) return;
        const measure = () => {
            const frame = frameRef.current;
            if (!frame) return;
            const rect = frame.getBoundingClientRect();
            const border = frame.clientLeft;
            const left = rect.left + border;
            const frameTop = rect.top + frame.clientTop;
            const width = Math.max(0, rect.width - border * 2);
            const frameHeight = Math.max(0, rect.height - frame.clientTop * 2);
            const viewport = getKeyboardViewport();
            const top = keyboardHeight > 0 ? Math.max(frameTop, viewport.top) : frameTop;
            const bottom =
                keyboardHeight > 0 ? Math.min(frameTop + frameHeight, viewport.bottom) : frameTop + frameHeight;
            const height = Math.max(0, bottom - top);
            Object.assign(host!.style, {
                top: `${top}px`,
                left: `${left}px`,
                width: `${width}px`,
                height: `${height}px`,
                visibility: width > 0 && height > 0 ? 'visible' : 'hidden',
            });
            host!.style.setProperty('--pane-width', `${width}px`);
            host!.style.setProperty('--pane-height', `${height}px`);
            frame.style.setProperty('--pane-width', `${width}px`);
            frame.style.setProperty('--pane-height', `${frameHeight}px`);
            if (contentRef.current !== frame) {
                contentRef.current?.style.setProperty('--pane-width', `${width}px`);
                contentRef.current?.style.setProperty('--pane-height', `${frameHeight}px`);
            }
        };

        measure();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
        if (frameRef.current) observer?.observe(frameRef.current);
        // Headers and ancestor layout can move a frame without resizing it.
        if (frameRef.current?.parentElement) observer?.observe(frameRef.current.parentElement);
        window.addEventListener('resize', measure);
        window.addEventListener('orientationchange', measure);
        window.addEventListener('scroll', measure, true);
        window.visualViewport?.addEventListener('resize', measure);
        window.visualViewport?.addEventListener('scroll', measure);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', measure);
            window.removeEventListener('orientationchange', measure);
            window.removeEventListener('scroll', measure, true);
            window.visualViewport?.removeEventListener('resize', measure);
            window.visualViewport?.removeEventListener('scroll', measure);
        };
    }, [scope, host, paneId, frameRef, contentRef, keyboardHeight]);

    return <PanePortalContext.Provider value={scope}>{children}</PanePortalContext.Provider>;
}

/** For existing portal surfaces. App-wide tools continue to target body. */
export function usePanePortalTarget(): HTMLElement | null {
    return useContext(PanePortalContext)?.host ?? (typeof document === 'undefined' ? null : document.body);
}

export function usePaneScope() {
    return useContext(PanePortalContext);
}

/** Convert viewport coordinates for popovers anchored to a measured control. */
export function panePortalPoint(target: HTMLElement, left: number, top: number) {
    if (!target.hasAttribute('data-pane-portal')) return { left, top };
    const bounds = target.getBoundingClientRect();
    return { left: left - bounds.left, top: top - bounds.top };
}

/** Anchor a menu to its button and keep its scrolling area inside the pane. */
export function panePopoverStyle(target: HTMLElement, anchor: DOMRect, width: number, gap = 8): React.CSSProperties {
    const scoped = target.hasAttribute('data-pane-portal');
    const bounds = scoped ? target.getBoundingClientRect() : null;
    const viewportWidth = bounds?.width ?? window.innerWidth;
    const viewportHeight = bounds?.height ?? window.innerHeight;
    const point = panePortalPoint(target, anchor.right, anchor.bottom);
    const localTop = anchor.top - (bounds?.top ?? 0);
    const below = Math.max(0, viewportHeight - point.top - gap - 8);
    const above = Math.max(0, localTop - gap - 8);
    const openAbove = below < 160 && above > below;
    return {
        position: 'fixed',
        ...(openAbove ? { bottom: viewportHeight - localTop + gap } : { top: point.top + gap }),
        right: Math.min(Math.max(viewportWidth - point.left, 8), Math.max(8, viewportWidth - width - 8)),
        width,
        maxWidth: 'calc(var(--pane-width, 100vw) - 16px)',
        maxHeight: openAbove ? above : below,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        zIndex: 9999,
    };
}

const paneModalLocks = new WeakMap<HTMLElement, { count: number; wasInert: boolean }>();

/** Block only the owning page while its dialog is open; leave the other pane usable. */
export function usePaneModalLock(active: boolean, portalRef?: React.RefObject<HTMLElement>) {
    const scope = usePaneScope();
    useEffect(() => {
        const content = scope?.contentRef.current;
        if (!active || !content) return;
        // Inline dialogs may live inside the page itself. Inert must never
        // disable an ancestor of the dialog we are trying to focus.
        if (portalRef && (!portalRef.current || !scope!.host.contains(portalRef.current))) return;
        const lock = paneModalLocks.get(content) ?? { count: 0, wasInert: content.hasAttribute('inert') };
        lock.count += 1;
        paneModalLocks.set(content, lock);
        content.setAttribute('inert', '');
        return () => {
            lock.count -= 1;
            if (lock.count === 0) {
                if (!lock.wasInert) content.removeAttribute('inert');
                paneModalLocks.delete(content);
            }
        };
    }, [active, scope, portalRef]);
}
