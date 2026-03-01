/**
 * Tests for FormField shared component
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FormField } from '../components/ui/FormField';

describe('FormField', () => {
    it('renders label text', () => {
        render(<FormField label="Item Name" value="" onChange={() => { }} />);
        expect(screen.getByText('Item Name')).toBeInTheDocument();
    });

    it('shows asterisk when required', () => {
        render(<FormField label="Item Name" value="" onChange={() => { }} required />);
        expect(screen.getByText('Item Name *')).toBeInTheDocument();
    });

    it('renders text input by default', () => {
        render(<FormField label="Name" value="test" onChange={() => { }} />);
        const input = screen.getByDisplayValue('test');
        expect(input.tagName).toBe('INPUT');
        expect(input).toHaveAttribute('type', 'text');
    });

    it('renders textarea when type is textarea', () => {
        render(<FormField label="Notes" type="textarea" value="hello" onChange={() => { }} />);
        const textarea = screen.getByDisplayValue('hello');
        expect(textarea.tagName).toBe('TEXTAREA');
    });

    it('renders date input', () => {
        render(<FormField label="Date" type="date" value="2026-03-01" onChange={() => { }} />);
        const input = screen.getByDisplayValue('2026-03-01');
        expect(input).toHaveAttribute('type', 'date');
    });

    it('calls onChange with new value', () => {
        const onChange = vi.fn();
        render(<FormField label="Name" value="" onChange={onChange} />);
        const input = screen.getByRole('textbox');
        fireEvent.change(input, { target: { value: 'New Value' } });
        expect(onChange).toHaveBeenCalledWith('New Value');
    });

    it('applies mono class when mono prop is set', () => {
        render(<FormField label="Barcode" value="123" onChange={() => { }} mono />);
        const input = screen.getByDisplayValue('123');
        expect(input.className).toContain('font-mono');
    });

    it('supports disabled state', () => {
        render(<FormField label="Name" value="" onChange={() => { }} disabled />);
        const input = screen.getByRole('textbox');
        expect(input).toBeDisabled();
    });

    it('renders placeholder text', () => {
        render(<FormField label="Name" value="" onChange={() => { }} placeholder="Enter name" />);
        expect(screen.getByPlaceholderText('Enter name')).toBeInTheDocument();
    });
});
