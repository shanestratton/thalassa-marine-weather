import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getKeyboardViewport, keepEditableAboveKeyboard, scheduleKeyboardAvoidance } from '../utils/keyboardScroll';

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

        expect(scrollBy).toHaveBeenCalledWith({ top: 488, behavior: 'smooth' });
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
