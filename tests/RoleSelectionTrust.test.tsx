import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RoleSelectionStep } from '../components/onboarding/RoleSelectionStep';

describe('onboarding role selection trust boundary', () => {
    it('personalises setup without presenting a role choice as a paid entitlement', () => {
        const onRoleChange = vi.fn();
        const onVesselTypeChange = vi.fn();
        render(
            <RoleSelectionStep
                selectedRole="skipper"
                onRoleChange={onRoleChange}
                onVesselTypeChange={onVesselTypeChange}
                onNext={vi.fn()}
            />,
        );

        expect(screen.getByText(/does not activate or change a paid plan/i)).toBeInTheDocument();
        expect(screen.queryByText(/\$\d+/)).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Select First Mate role' }));
        expect(onRoleChange).toHaveBeenCalledWith('crew');
        expect(onVesselTypeChange).toHaveBeenCalledWith('observer');
    });
});
