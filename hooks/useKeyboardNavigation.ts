import { useEffect } from 'react';

interface UseKeyboardNavigationProps {
    onPrevious?: () => void;
    onNext?: () => void;
    onRefresh?: () => void;
    onSettings?: () => void;
    enabled?: boolean;
}

/**
 * Custom hook for keyboard navigation
 * Enables arrow keys, refresh (r), settings (s) shortcuts
 */
export const useKeyboardNavigation = ({
    onPrevious,
    onNext,
    onRefresh,
    onSettings,
    enabled = true
}: UseKeyboardNavigationProps) => {
    useEffect(() => {
        if (!enabled) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            // Don't intercept if user is typing in an input
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
                return;
            }

            switch (event.key) {
                case 'ArrowLeft':
                    event.preventDefault();
                    onPrevious?.();
                    break;
                case 'ArrowRight':
                    event.preventDefault();
                    onNext?.();
                    break;
                case 'r':
                case 'R':
                    if (!event.metaKey && !event.ctrlKey) {
                        event.preventDefault();
                        onRefresh?.();
                    }
                    break;
                case 's':
                case 'S':
                    if (!event.metaKey && !event.ctrlKey) {
                        event.preventDefault();
                        onSettings?.();
                    }
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [enabled, onPrevious, onNext, onRefresh, onSettings]);
};
