import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AisDisplaySettings } from '../components/settings/AisDisplaySettings';
import { DEFAULT_SETTINGS } from '../stores/settingsStore';
afterEach(cleanup);
describe('account AIS display preferences', () => {
    it('saves a full bounded preference object and explains the fixed safety override', () => {
        const onSave = vi.fn();
        render(<AisDisplaySettings settings={DEFAULT_SETTINGS} onSave={onSave} />);
        expect(screen.getByLabelText('Vessel type')).toHaveValue('all');
        expect(screen.getByText(/collision alarm checks every target/)).toBeTruthy();
        fireEvent.change(screen.getByLabelText('Vessel type'), { target: { value: 'sailing' } });
        expect(onSave).toHaveBeenLastCalledWith({
            aisDisplayFilters: { vesselType: 'sailing', source: 'all', minSpeedKn: 0, hideMoored: false },
        });
        fireEvent.change(screen.getByLabelText('Minimum AIS speed'), { target: { value: '2' } });
        expect(onSave).toHaveBeenLastCalledWith({
            aisDisplayFilters: { vesselType: 'all', source: 'all', minSpeedKn: 2, hideMoored: false },
        });
        fireEvent.change(screen.getByLabelText('AIS source'), { target: { value: 'local' } });
        expect(onSave).toHaveBeenLastCalledWith({
            aisDisplayFilters: { vesselType: 'all', source: 'local', minSpeedKn: 0, hideMoored: false },
        });
        fireEvent.click(screen.getByRole('switch', { name: 'Hide moored and anchored vessels' }));
        expect(onSave).toHaveBeenLastCalledWith({
            aisDisplayFilters: { vesselType: 'all', source: 'all', minSpeedKn: 0, hideMoored: true },
        });
    });
});
