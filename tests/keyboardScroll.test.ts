import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getKeyboardViewport,
    initGlobalKeyboardScroll,
    keepEditableAboveKeyboard,
    scheduleKeyboardAvoidance,
} from '../utils/keyboardScroll';

const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');

function setViewport({ height, offsetTop = 0 }: { height: number; offsetTop?: number }) {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: {
            height,
            offsetTop,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        },
    });
}

function restoreViewport() {
    if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight);
    if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport);
    else Reflect.deleteProperty(window, 'visualViewport');
}

function scrollableForm() {
    const form = document.createElement('div');
    form.style.overflowY = 'auto';
    Object.defineProperties(form, {
        scrollHeight: { configurable: true, value: 1200 },
        clientHeight: { configurable: true, value: 480 },
    });
    const scrollBy = vi.fn();
    Object.assign(form, { scrollBy });
    document.body.appendChild(form);
    return { form, scrollBy };
}

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    vi.useRealTimers();
    restoreViewport();
    document.body.innerHTML = '';
});

describe('keyboardScroll', () => {
    it('uses the visual viewport as the web keyboard edge', () => {
        setViewport({ height: 500 });

        expect(getKeyboardViewport()).toEqual({
            top: 72,
            bottom: 480,
            height: 408,
            keyboardHeight: 344,
        });
    });

    it('moves the nearest scrollable form only when the field is below the keyboard', () => {
        setViewport({ height: 500 });
        const { form, scrollBy } = scrollableForm();
        const input = document.createElement('input');
        form.appendChild(input);
        vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
            x: 0,
            y: 600,
            top: 600,
            bottom: 640,
            left: 0,
            right: 200,
            width: 200,
            height: 40,
            toJSON: () => ({}),
        });

        keepEditableAboveKeyboard(input);

        // CENTRED placement (2026-09-02): band = [72, 480] → height 408;
        // preferredTop = 72 + (408-40)/2 = 256; delta = 600-256 = 344. And
        // 'auto', never 'smooth' — mid-animation re-measures caused the
        // multi-field "spin".
        expect(scrollBy).toHaveBeenCalledWith({ top: 344, behavior: 'auto' });
    });

    it('protects contenteditable composers as well as native form controls', () => {
        vi.useFakeTimers();
        setViewport({ height: 500 });
        const { form, scrollBy } = scrollableForm();
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.tabIndex = 0;
        form.appendChild(editor);
        vi.spyOn(editor, 'getBoundingClientRect').mockReturnValue({
            x: 0,
            y: 600,
            top: 600,
            bottom: 640,
            left: 0,
            right: 200,
            width: 200,
            height: 40,
            toJSON: () => ({}),
        });
        editor.focus();

        scheduleKeyboardAvoidance(editor);
        vi.runAllTimers();

        expect(scrollBy).toHaveBeenCalled();
    });

    it('does not jolt a form when its focused field already fits', () => {
        setViewport({ height: 500 });
        const { form, scrollBy } = scrollableForm();
        const textarea = document.createElement('textarea');
        form.appendChild(textarea);
        vi.spyOn(textarea, 'getBoundingClientRect').mockReturnValue({
            x: 0,
            y: 180,
            top: 180,
            bottom: 230,
            left: 0,
            right: 200,
            width: 200,
            height: 50,
            toJSON: () => ({}),
        });

        keepEditableAboveKeyboard(textarea);

        expect(scrollBy).not.toHaveBeenCalled();
    });

    it('leaves explicitly managed compact pickers alone', () => {
        setViewport({ height: 500 });
        const { form, scrollBy } = scrollableForm();
        const input = document.createElement('input');
        input.dataset.noKeyboardScroll = '';
        form.appendChild(input);
        vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
            x: 0,
            y: 600,
            top: 600,
            bottom: 640,
            left: 0,
            right: 200,
            width: 200,
            height: 40,
            toJSON: () => ({}),
        });

        keepEditableAboveKeyboard(input);

        expect(scrollBy).not.toHaveBeenCalled();
    });
});

describe('return-key navigation (2026-09-02)', () => {
    // "when you press … either the keyboard disappears or the next box
    // becomes focused" — Return walks the cluster, Done on the last field.
    const buildForm = () => {
        const form = document.createElement('div');
        Object.defineProperty(form, 'scrollHeight', { value: 2000, configurable: true });
        Object.defineProperty(form, 'clientHeight', { value: 500, configurable: true });
        form.style.overflowY = 'auto';
        const a = document.createElement('input');
        const b = document.createElement('input');
        const notes = document.createElement('textarea');
        form.append(a, b, notes);
        document.body.appendChild(form);
        // jsdom reports no client rects; the cluster filter demands one.
        for (const el of [a, b, notes]) {
            vi.spyOn(el, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
        }
        return { form, a, b, notes };
    };

    it('Enter moves focus to the next field in the same scroll cluster', () => {
        const stop = initGlobalKeyboardScroll();
        const { a, b } = buildForm();
        a.focus();
        a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(b);
        stop();
    });

    it('Enter on the last single-line field dismisses the keyboard (blur)', () => {
        const stop = initGlobalKeyboardScroll();
        const { b, notes } = buildForm();
        notes.remove(); // textareas are not Return targets; make b the last
        b.focus();
        b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(document.activeElement).not.toBe(b);
        stop();
    });

    it('a component that already handled Enter always wins', () => {
        const stop = initGlobalKeyboardScroll();
        const { a, b } = buildForm();
        a.addEventListener('keydown', (e) => e.preventDefault());
        a.focus();
        a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(a);
        expect(document.activeElement).not.toBe(b);
        stop();
    });

    it('textareas keep Enter for newlines', () => {
        const stop = initGlobalKeyboardScroll();
        const { notes } = buildForm();
        notes.focus();
        notes.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(notes);
        stop();
    });
});
