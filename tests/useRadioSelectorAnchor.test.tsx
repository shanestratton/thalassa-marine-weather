import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanePortalContext } from '../context/PanePortalContext';
import { useRadioSelectorAnchor } from '../components/vessel/useRadioSelectorAnchor';

function Probe() {
    const { selectorRef, anchor } = useRadioSelectorAnchor();
    return (
        <>
            <div ref={selectorRef} data-testid="anchor" />
            <output data-testid="measurement">{JSON.stringify(anchor)}</output>
        </>
    );
}

function bounds(left: number, top: number, width: number): DOMRect {
    return { left, top, width, height: 72, x: left, y: top, right: left + width, bottom: top + 72, toJSON: () => ({}) };
}

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('radio call-selector portal anchor', () => {
    it('retains phone page coordinates below app chrome instead of assuming a header height', () => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds(16, 174, 358));
        render(<Probe />);
        expect(JSON.parse(screen.getByTestId('measurement').textContent!)).toEqual({ left: 16, top: 174, width: 358 });
    });

    it('subtracts the owning pane origin, including its border, and follows viewport reflow', () => {
        const host = document.createElement('div');
        const frame = document.createElement('div');
        const scope = { id: 'page', host, frameRef: { current: frame }, contentRef: { current: frame } };
        let selector = bounds(578, 214, 414);
        let origin = bounds(562, 138, 446);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            return this === host ? origin : selector;
        });
        render(
            <PanePortalContext.Provider value={scope}>
                <Probe />
            </PanePortalContext.Provider>,
        );
        expect(JSON.parse(screen.getByTestId('measurement').textContent!)).toEqual({ left: 16, top: 76, width: 414 });

        selector = bounds(496, 188, 352);
        origin = bounds(480, 116, 384);
        fireEvent.resize(window);
        expect(JSON.parse(screen.getByTestId('measurement').textContent!)).toEqual({ left: 16, top: 72, width: 352 });
        selector = bounds(496, 176, 352);
        fireEvent.scroll(window);
        expect(JSON.parse(screen.getByTestId('measurement').textContent!)).toEqual({ left: 16, top: 60, width: 352 });
    });
});
