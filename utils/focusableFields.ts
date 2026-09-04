/** Shared eligibility rules for form focus, without starting keyboard listeners. */
export const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
export const FORM_FOCUS_SCOPE =
    'form, [data-keyboard-focus-scope], [data-modal-sheet], [role="dialog"], [role="alertdialog"]';

export function isAvailableForFocus(element: HTMLElement): boolean {
    if (element.matches(':disabled') || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (element instanceof HTMLInputElement && element.type === 'hidden') return false;
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = window.getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
}

/** Native date/select pickers are not text-entry fields or keyboard Next targets. */
export function isTextEntry(element: HTMLElement): boolean {
    if (!isAvailableForFocus(element) || (element.hasAttribute('tabindex') && element.tabIndex < 0)) return false;
    if (element instanceof HTMLTextAreaElement) return !element.readOnly;
    if (element instanceof HTMLInputElement) {
        return (
            !element.readOnly && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(element.type)
        );
    }
    return (
        element.isContentEditable ||
        element.matches('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')
    );
}
