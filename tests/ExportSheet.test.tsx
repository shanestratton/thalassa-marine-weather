/**
 * ExportSheet — extracted PDF/GPX export action sheet tests.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ExportSheet } from '../pages/log/ExportSheet';

describe('ExportSheet', () => {
    const defaultProps = {
        onClose: vi.fn(),
        selectedVoyageId: null as string | null,
        hasNonDeviceEntries: false,
        onExportPDF: vi.fn().mockResolvedValue(undefined),
        onExportGPX: vi.fn().mockResolvedValue(undefined),
    };

    it('renders export header', () => {
        render(<ExportSheet {...defaultProps} />);
        expect(screen.getByText('Export Voyage')).toBeInTheDocument();
    });

    it('renders both export options', () => {
        render(<ExportSheet {...defaultProps} />);
        expect(screen.getByText('Official Deck Log')).toBeInTheDocument();
        expect(screen.getByText('GPS Track (GPX)')).toBeInTheDocument();
    });

    it('shows "Export all" when no voyage selected', () => {
        render(<ExportSheet {...defaultProps} selectedVoyageId={null} />);
        expect(screen.getByText('Export all voyage data')).toBeInTheDocument();
    });

    it('shows "Export the selected voyage" when a voyage is selected', () => {
        render(<ExportSheet {...defaultProps} selectedVoyageId="voyage-123" />);
        expect(screen.getByText('Export the selected voyage')).toBeInTheDocument();
    });

    it('calls onClose when close button is clicked', () => {
        const onClose = vi.fn();
        render(<ExportSheet {...defaultProps} onClose={onClose} />);
        fireEvent.click(screen.getByLabelText('Close'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onExportGPX when GPX button is clicked', async () => {
        const onExportGPX = vi.fn().mockResolvedValue(undefined);
        render(<ExportSheet {...defaultProps} onExportGPX={onExportGPX} />);
        fireEvent.click(screen.getByLabelText('Export as GPX'));
        await waitFor(() => {
            expect(onExportGPX).toHaveBeenCalledTimes(1);
        });
    });

    it('calls onExportPDF when PDF button is clicked and no non-device entries', async () => {
        const onExportPDF = vi.fn().mockResolvedValue(undefined);
        render(<ExportSheet {...defaultProps} onExportPDF={onExportPDF} hasNonDeviceEntries={false} />);
        fireEvent.click(screen.getByLabelText('Export as PDF'));
        await waitFor(() => {
            expect(onExportPDF).toHaveBeenCalledTimes(1);
        });
    });

    it('shows warning and disables PDF when hasNonDeviceEntries is true', () => {
        render(<ExportSheet {...defaultProps} hasNonDeviceEntries={true} />);
        expect(screen.getByText(/Unavailable/)).toBeInTheDocument();
        const pdfButton = screen.getByLabelText('Export as PDF');
        expect(pdfButton).toBeDisabled();
    });

    it('does NOT call onExportPDF when disabled', () => {
        const onExportPDF = vi.fn();
        render(<ExportSheet {...defaultProps} onExportPDF={onExportPDF} hasNonDeviceEntries={true} />);
        fireEvent.click(screen.getByLabelText('Export as PDF'));
        expect(onExportPDF).not.toHaveBeenCalled();
    });
});
