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

    it('keeps Next inside a short dialog even when it has no overflow', () => {
        const stop = initGlobalKeyboardScroll();
        const { form, a, b, notes } = buildForm();
        form.style.overflowY = 'visible';
        form.setAttribute('role', 'dialog');
        notes.remove();
        const background = document.createElement('input');
        document.body.append(background);
        vi.spyOn(background, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
        a.focus();
        a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(b).toHaveFocus();
        b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(background).not.toHaveFocus();
        expect(b).not.toHaveFocus();
        stop();
    });

    it('skips readonly, disabled-fieldset, inert, hidden and picker controls', () => {
        const stop = initGlobalKeyboardScroll();
        const { a, b } = buildForm();
        const readonly = document.createElement('input');
        readonly.readOnly = true;
        const fieldset = document.createElement('fieldset');
        fieldset.disabled = true;
        fieldset.append(document.createElement('input'));
        const hidden = document.createElement('input');
        hidden.style.visibility = 'hidden';
        const inert = document.createElement('div');
        inert.setAttribute('inert', '');
        inert.append(document.createElement('input'));
        const date = document.createElement('input');
        date.type = 'date';
        a.after(readonly, fieldset, hidden, inert, date);
        for (const el of [readonly, fieldset.firstElementChild!, hidden, inert.firstElementChild!, date]) {
            vi.spyOn(el, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
        }
        a.focus();
        a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(b).toHaveFocus();
        stop();
    });

    it.each(['search', 'send', 'go', 'enter'])('respects an authored %s action', (hint) => {
        const stop = initGlobalKeyboardScroll();
        const { a } = buildForm();
        a.enterKeyHint = hint;
        a.focus();
        const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        a.dispatchEvent(event);
        expect(a).toHaveFocus();
        expect(event.defaultPrevented).toBe(false);
        stop();
    });

    it('does not change fields while accepting an IME composition', () => {
        const stop = initGlobalKeyboardScroll();
        const { a } = buildForm();
        a.focus();
        const event = new KeyboardEvent('keydown', {
            key: 'Enter',
            isComposing: true,
            bubbles: true,
            cancelable: true,
        });
        a.dispatchEvent(event);
        expect(a).toHaveFocus();
        expect(event.defaultPrevented).toBe(false);
        stop();
    });

    it('honours an explicit Done and a Search hint changed by the component after focus', () => {
        const stop = initGlobalKeyboardScroll();
        const { a, b } = buildForm();
        a.enterKeyHint = 'done';
        a.focus();
        a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(a).not.toHaveFocus();
        expect(b).not.toHaveFocus();
        b.focus();
        b.enterKeyHint = 'search';
        const search = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        b.dispatchEvent(search);
        expect(search.defaultPrevented).toBe(false);
        expect(b).toHaveFocus();
        stop();
    });

    it('leaves the final field of a real form free to submit normally', () => {
        const stop = initGlobalKeyboardScroll();
        const form = document.createElement('form');
        const input = document.createElement('input');
        form.append(input);
        document.body.append(form);
        vi.spyOn(input, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
        input.focus();
        const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        stop();
    });
});

describe('keyboard positioning regressions', () => {
    const rect = (top: number, height = 40, width = 200): DOMRect => ({
        x: 0,
        y: top,
        top,
        bottom: top + height,
        left: 0,
        right: width,
        height,
        width,
        toJSON: () => ({}),
    });

    it('centres a newly focused field even when it only just fits above the keyboard', () => {
        setViewport({ height: 500 });
        const { form, scrollBy } = scrollableForm();
        const input = document.createElement('input');
        form.append(input);
        vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(430));
        keepEditableAboveKeyboard(input, true);
        expect(scrollBy).toHaveBeenCalledWith({ top: 174, behavior: 'auto' });
    });

    it('centres below the real sticky header, not behind it', () => {
        setViewport({ height: 500 });
        const { form, scrollBy } = scrollableForm();
        vi.spyOn(form, 'getBoundingClientRect').mockReturnValue(rect(100, 700));
        const header = document.createElement('header');
        header.style.position = 'sticky';
        header.style.top = '0px';
        vi.spyOn(header, 'getBoundingClientRect').mockReturnValue(rect(100, 140));
        const input = document.createElement('input');
        form.append(header, input);
        vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(600));
        keepEditableAboveKeyboard(input, true);
        // The real band is [252, 480], so the field's top belongs at 346.
        expect(scrollBy).toHaveBeenCalledWith({ top: 254, behavior: 'auto' });
    });

    it('adds only missing scroll travel to a short form and restores its padding when the keyboard closes', () => {
        setViewport({ height: 500 });
        const viewport = new EventTarget();
        Object.assign(viewport, { height: 500, offsetTop: 0, scale: 1 });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
        const stop = initGlobalKeyboardScroll();
        const { form, scrollBy } = scrollableForm();
        Object.defineProperty(form, 'scrollHeight', { configurable: true, value: 480 });
        form.style.paddingBottom = '16px';
        const input = document.createElement('input');
        form.append(input);
        vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(600));
        keepEditableAboveKeyboard(input, true);
        expect(form.style.paddingBottom).toBe('360px');
        expect(scrollBy).toHaveBeenCalledWith({ top: 344, behavior: 'auto' });
        Object.assign(viewport, { height: 844 });
        viewport.dispatchEvent(new Event('resize'));
        expect(form.style.paddingBottom).toBe('16px');
        stop();
    });

    it('settles on the second field after a rapid tap, never on the first one', () => {
        vi.useFakeTimers();
        setViewport({ height: 500 });
        const stop = initGlobalKeyboardScroll();
        const { form, scrollBy } = scrollableForm();
        const first = document.createElement('input');
        const second = document.createElement('input');
        form.append(first, second);
        vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(rect(550));
        let secondTop = 600;
        vi.spyOn(second, 'getBoundingClientRect').mockImplementation(() => rect(secondTop));
        scrollBy.mockImplementation(({ top }: { top: number }) => {
            secondTop -= top;
        });
        first.focus();
        second.focus();
        vi.runAllTimers();
        expect(second).toHaveFocus();
        expect(secondTop).toBe(256);
        expect(scrollBy).toHaveBeenCalledTimes(1);
        stop();
    });

    it('does not classify pinch zoom as keyboard height', () => {
        setViewport({ height: 400 });
        Object.assign(window.visualViewport!, { scale: 2 });
        expect(getKeyboardViewport().keyboardHeight).toBe(0);
    });
});
