import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SailInventoryEditor from '../components/settings/SailInventoryEditor';
import SailAdviceLine from '../components/passage/SailAdviceLine';
import { sailInventoryFixture, sailWindFixture } from './helpers/sailInventoryFixture';

afterEach(cleanup);
describe('lazy sail editor and passage advice', () => {
    it('saves an explicit edited inventory without mutating the original or assuming additional sails', () => {
        const value = sailInventoryFixture(),
            save = vi.fn(),
            close = vi.fn();
        render(
            <SailInventoryEditor value={value} vesselName="Synthetic selected boat" onSave={save} onClose={close} />,
        );
        fireEvent.change(screen.getAllByLabelText('Name')[0], { target: { value: 'My main' } });
        expect(save).not.toHaveBeenCalled();
        expect(value.sails[0].name).toBe('Fixture main');
        fireEvent.click(screen.getByRole('button', { name: 'Save sail inventory' }));
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][0].sails.map((s: { name: string }) => s.name)).toEqual(['My main', 'Fixture jib']);
        expect(close).toHaveBeenCalledTimes(1);
    });
    it('requires complete valid ranges and actual selected sails before saving a crossover', () => {
        const save = vi.fn();
        render(
            <SailInventoryEditor
                value={sailInventoryFixture()}
                vesselName="Synthetic boat"
                onSave={save}
                onClose={() => undefined}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Add crossover plan' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save sail inventory' }));
        expect(save).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toHaveTextContent('Check names');
    });
    it('leaves a removed sail’s now-empty plan invalid instead of silently replacing its rig', () => {
        const save = vi.fn();
        render(
            <SailInventoryEditor
                value={sailInventoryFixture()}
                vesselName="Synthetic boat"
                onSave={save}
                onClose={() => undefined}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Remove sail 1' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save sail inventory' }));
        expect(save).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toBeVisible();
    });
    it('dismisses without saving and keeps changes local to the editor draft', () => {
        const save = vi.fn(),
            close = vi.fn();
        render(<SailInventoryEditor value={null} vesselName="Synthetic boat" onSave={save} onClose={close} />);
        expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Add sail' }));
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Custom sail' } });
        fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
        expect(close).toHaveBeenCalledOnce();
        expect(save).not.toHaveBeenCalled();
    });
    it('applies wind-drop hysteresis and immediately forgets previous advice when the boat changes', () => {
        const props = { inventory: sailInventoryFixture(), vesselType: 'sail', scopeKey: 'account-a:boat-a' };
        const view = render(<SailAdviceLine {...props} sample={sailWindFixture(16)} />);
        view.rerender(<SailAdviceLine {...props} sample={sailWindFixture(14, 1000)} />);
        expect(screen.getByTestId('passage-sail-plan')).toHaveTextContent('Reduced plan');
        view.rerender(<SailAdviceLine {...props} scopeKey="account-a:boat-b" sample={sailWindFixture(14, 2000)} />);
        expect(screen.getByTestId('passage-sail-plan')).toHaveTextContent('Light plan');
        view.rerender(<SailAdviceLine {...props} sample={null} />);
        expect(screen.getByTestId('passage-sail-plan')).toHaveTextContent('Sail plan unavailable');
    });
});
