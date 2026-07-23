/**
 * Keyboard lifecycle for small, non-modal ARIA menus.
 *
 * Focus enters the first enabled menu item, arrow/Home/End keys move through
 * menu items, and Escape closes the menu and restores its trigger. Tab remains
 * native so a menu never behaves like a modal focus trap.
 */

import { useEffect, useRef, type RefObject } from 'react';

interface MenuNavigationOptions {
    triggerRef: RefObject<HTMLElement | null>;
    onClose: () => void;
}

const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled])';

export function useMenuNavigation<T extends HTMLElement = HTMLDivElement>(
    isOpen: boolean,
    options: MenuNavigationOptions,
): RefObject<T | null> {
    const menuRef = useRef<T | null>(null);
    const optionsRef = useRef(options);
    optionsRef.current = options;

    useEffect(() => {
        if (!isOpen || typeof document === 'undefined') return;
        const menu = menuRef.current;
        if (!menu) return;

        const items = () => Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
        const firstItem = items()[0];
        const addedTabIndex = !firstItem && !menu.hasAttribute('tabindex');
        if (addedTabIndex) menu.setAttribute('tabindex', '-1');
        (firstItem ?? menu).focus();
        let shouldRestoreFocus = menu.contains(document.activeElement) || document.activeElement === menu;

        const onFocusIn = () => {
            shouldRestoreFocus = true;
        };
        const onFocusOut = (event: FocusEvent) => {
            const next = event.relatedTarget;
            // A null relatedTarget is normal when React removes the focused
            // menu item. Keep restoration armed in that case. A real target
            // outside the menu means the user intentionally Tabbed away.
            if (next instanceof Node && !menu.contains(next)) shouldRestoreFocus = false;
        };

        const onKeyDown = (event: KeyboardEvent) => {
            const menuItems = items();
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                optionsRef.current.onClose();
                optionsRef.current.triggerRef.current?.focus({ preventScroll: true });
                return;
            }
            if (menuItems.length === 0) return;

            const activeIndex = menuItems.indexOf(document.activeElement as HTMLElement);
            let nextIndex: number | null = null;
            if (event.key === 'ArrowDown') nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % menuItems.length;
            if (event.key === 'ArrowUp')
                nextIndex =
                    activeIndex < 0 ? menuItems.length - 1 : (activeIndex - 1 + menuItems.length) % menuItems.length;
            if (event.key === 'Home') nextIndex = 0;
            if (event.key === 'End') nextIndex = menuItems.length - 1;
            if (nextIndex === null) return;

            event.preventDefault();
            menuItems[nextIndex]?.focus();
        };

        menu.addEventListener('keydown', onKeyDown);
        menu.addEventListener('focusin', onFocusIn);
        menu.addEventListener('focusout', onFocusOut);
        return () => {
            menu.removeEventListener('keydown', onKeyDown);
            menu.removeEventListener('focusin', onFocusIn);
            menu.removeEventListener('focusout', onFocusOut);
            if (addedTabIndex) menu.removeAttribute('tabindex');
            if (shouldRestoreFocus) {
                optionsRef.current.triggerRef.current?.focus({ preventScroll: true });
            }
        };
    }, [isOpen]);

    return menuRef;
}
