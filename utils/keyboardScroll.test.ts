/**
 * keyboardScroll — Unit tests for keyboard scroll helpers.
 */
import { describe, it, expect } from 'vitest';
import { scrollInputAboveKeyboard } from './keyboardScroll';

// scrollInputAboveKeyboard takes a FocusEvent, not an HTMLElement
function makeFocusEvent(target: HTMLElement): React.FocusEvent<HTMLInputElement> {
    return { target, currentTarget: target } as unknown as React.FocusEvent<HTMLInputElement>;
}

describe('scrollInputAboveKeyboard', () => {
    it('does not throw when called with a focus event', () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        expect(() => scrollInputAboveKeyboard(makeFocusEvent(input))).not.toThrow();
        document.body.removeChild(input);
    });

    it('handles repeated calls', () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        scrollInputAboveKeyboard(makeFocusEvent(input));
        scrollInputAboveKeyboard(makeFocusEvent(input));
        document.body.removeChild(input);
    });
});
