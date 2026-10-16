import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TracerPinEditor } from '../components/map/tracer/TracerPinEditor';
import type { TraceRoutePoint } from '../services/routing/traceRoutePoint';
vi.mock('../utils/system', async (original) => ({
    ...(await original<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
const initial: TraceRoutePoint[] = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 0, lon: 2 },
];
function Harness({ points = initial, selected = 1 }: { points?: TraceRoutePoint[]; selected?: number }) {
    const [pins, setPins] = useState(points),
        [feedback, setFeedback] = useState('');
    return (
        <>
            <TracerPinEditor
                selectedPin={selected}
                setSelectedPin={() => {}}
                pinCount={pins.length}
                point={pins[selected]}
                previous={pins[selected - 1]}
                next={pins[selected + 1]}
                setCapturedCoords={setPins}
                legAnchor={null}
                insertAfter={null}
                setInsertAfter={() => {}}
                insertAfterRef={{ current: null }}
                flashTraceFeedback={setFeedback}
            />
            <output data-testid="points">{JSON.stringify(pins)}</output>
            <output>{feedback}</output>
        </>
    );
}
describe('the real Tracer pin intent editor', () => {
    it('shows the original mark and a distinct passing point, then restores a must-pass mark', () => {
        render(<Harness />);
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Passing offset in metres' }), {
            target: { value: '100' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Leave port' }));
        const pins = JSON.parse(screen.getByTestId('points').textContent!);
        expect(pins[1]).toMatchObject({
            constraint: { lat: 0, lon: 1, leaveSide: 'port', standOffM: 100, courseBearing: 90 },
        });
        expect(pins[1].lat).toBeLessThan(0);
        expect(screen.getByText(/Original mark 0.00000, 1.00000/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Leave port' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByRole('button', { name: 'Must pass' }));
        expect(JSON.parse(screen.getByTestId('points').textContent!)[1]).toEqual(initial[1]);
    });
    it('refuses invalid offsets without changing pins or inventing clearance', () => {
        render(<Harness />);
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });
        fireEvent.click(screen.getByRole('button', { name: 'Leave starboard' }));
        expect(JSON.parse(screen.getByTestId('points').textContent!)).toEqual(initial);
        expect(screen.getByText(/Choose a passing offset from 5 to 2000 m/)).toBeInTheDocument();
    });
    it('can promote an engine shape point but does not attach side controls to a terminal', () => {
        const view = render(<Harness points={[initial[0], { ...initial[1], shape: true }, initial[2]]} />);
        fireEvent.click(screen.getByRole('button', { name: 'Must pass' }));
        expect(JSON.parse(screen.getByTestId('points').textContent!)[1]).toEqual(initial[1]);
        view.unmount();
        render(<Harness selected={0} />);
        expect(screen.queryByRole('button', { name: 'Leave port' })).not.toBeInTheDocument();
    });
});
