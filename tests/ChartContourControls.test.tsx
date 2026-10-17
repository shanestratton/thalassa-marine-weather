import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChartContourControls from '../components/map/ChartContourControls';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const value = { shallowM: 2, safetyM: 6, deepM: 30, reliefSafety: false };
beforeEach(() => setAuthIdentityScope('contour-owner'));
afterEach(cleanup);
describe('explicit contour editor', () => {
    it('validates all fields atomically, changes nothing on editing, and applies only after deliberate action', () => {
        const change = vi.fn();
        render(<ChartContourControls value={value} requiredM={3} draftAssumed unit="m" onChange={change} />);
        expect(screen.getByText(/Draft is assumed/)).toBeVisible();
        fireEvent.change(screen.getByRole('textbox', { name: 'Shallow (m)' }), { target: { value: '12' } });
        expect(change).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Apply bands' }));
        expect(screen.getByRole('alert')).toHaveTextContent('shallow < safety < deep');
        expect(change).not.toHaveBeenCalled();
        fireEvent.change(screen.getByRole('textbox', { name: 'Shallow (m)' }), { target: { value: '2' } });
        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(screen.getByRole('button', { name: 'Apply bands' }));
        expect(change).toHaveBeenCalledWith({ ...value, reliefSafety: true });
    });
    it('preserves exact metre thresholds when unchanged feet fields are reapplied, and converts a deliberate feet edit', () => {
        const change = vi.fn();
        render(<ChartContourControls value={value} requiredM={3} draftAssumed={false} unit="ft" onChange={change} />);
        expect(screen.getByRole('textbox', { name: 'Shallow (ft)' })).toHaveValue('6.56');
        fireEvent.click(screen.getByRole('button', { name: 'Apply bands' }));
        expect(change).toHaveBeenLastCalledWith(value);
        fireEvent.change(screen.getByRole('textbox', { name: 'Safety (ft)' }), { target: { value: '32.8084' } });
        fireEvent.click(screen.getByRole('button', { name: 'Apply bands' }));
        expect(change).toHaveBeenLastCalledWith({ ...value, safetyM: 10 });
    });
    it('shows a conservative effective floor without rewriting the chosen input; reset removes the custom display choice', () => {
        const change = vi.fn();
        render(<ChartContourControls value={value} requiredM={8} draftAssumed={false} unit="m" onChange={change} />);
        expect(screen.getByRole('textbox', { name: 'Safety (m)' })).toHaveValue('6');
        expect(screen.getByText(/Safety is raised to the vessel minimum/)).toBeVisible();
        expect(screen.getByText(/Active: 2 \/ 8 \/ 30 m/)).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Reset bands' }));
        expect(change).toHaveBeenCalledWith(null);
    });
    it('refuses old-account Apply and Reset events before the closing sheet has unmounted', () => {
        const change = vi.fn();
        render(<ChartContourControls value={value} requiredM={3} draftAssumed={false} unit="m" onChange={change} />);
        setAuthIdentityScope('different-contour-owner');
        fireEvent.click(screen.getByRole('button', { name: 'Apply bands' }));
        fireEvent.click(screen.getByRole('button', { name: 'Reset bands' }));
        expect(change).not.toHaveBeenCalled();
    });
});
