/**
 * useSuccessFlash — Triggers a brief green highlight flash on save.
 *
 * Returns a ref to attach to any container and a `flash()` function
 * that adds the `.success-flash` CSS class for 600ms.
 *
 * Usage:
 *   const { ref, flash } = useSuccessFlash();
 *   // After saving: flash();
 *   // In JSX: <div ref={ref}>...</div>
 */
import { useRef, useCallback, useEffect } from 'react';

export function useSuccessFlash<T extends HTMLElement = HTMLDivElement>() {
    const ref = useRef<T>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const flashedElementRef = useRef<T | null>(null);

    useEffect(
        () => () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            flashedElementRef.current?.classList.remove('success-flash');
        },
        [],
    );

    const flash = useCallback(() => {
        const el = ref.current;
        if (!el) return;

        if (timerRef.current) clearTimeout(timerRef.current);
        flashedElementRef.current?.classList.remove('success-flash');

        // Remove any existing flash first (if rapid saves)
        el.classList.remove('success-flash');
        // Force reflow to restart animation
        void el.offsetWidth;
        el.classList.add('success-flash');
        flashedElementRef.current = el;
        timerRef.current = setTimeout(() => {
            el.classList.remove('success-flash');
            if (flashedElementRef.current === el) flashedElementRef.current = null;
            timerRef.current = null;
        }, 650);
    }, []);

    return { ref, flash };
}
