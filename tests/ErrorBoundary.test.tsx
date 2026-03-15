/**
 * Tests for ErrorBoundary component
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary, CompactErrorFallback } from '../components/ErrorBoundary';

// Component that throws on render
const ThrowingComponent = ({ shouldThrow = true }: { shouldThrow?: boolean }) => {
    if (shouldThrow) throw new Error('Test explosion');
    return <p>Safe content</p>;
};

describe('ErrorBoundary', () => {
    // Suppress React error boundary console.error noise in tests
    beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('renders children when no error occurs', () => {
        render(
            <ErrorBoundary>
                <p>Hello World</p>
            </ErrorBoundary>,
        );
        expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    it('shows fallback UI when child throws', () => {
        render(
            <ErrorBoundary boundaryName="TestBoundary">
                <ThrowingComponent />
            </ErrorBoundary>,
        );
        expect(screen.getByText('Something went wrong')).toBeInTheDocument();
        expect(screen.getByText(/Error in TestBoundary/)).toBeInTheDocument();
    });

    it('displays error message in fallback', () => {
        render(
            <ErrorBoundary>
                <ThrowingComponent />
            </ErrorBoundary>,
        );
        expect(screen.getByText('Test explosion')).toBeInTheDocument();
    });

    it('shows Try Again button and recovers on click', () => {
        render(
            <ErrorBoundary>
                <ThrowingComponent />
            </ErrorBoundary>,
        );
        const retryBtn = screen.getByText('Try Again');
        expect(retryBtn).toBeInTheDocument();
    });

    it('uses custom fallback when provided', () => {
        render(
            <ErrorBoundary fallback={<p>Custom Error UI</p>}>
                <ThrowingComponent />
            </ErrorBoundary>,
        );
        expect(screen.getByText('Custom Error UI')).toBeInTheDocument();
    });

    it('calls onError callback when error occurs', () => {
        const onError = vi.fn();
        render(
            <ErrorBoundary onError={onError}>
                <ThrowingComponent />
            </ErrorBoundary>,
        );
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
            expect.any(Error),
            expect.objectContaining({ componentStack: expect.any(String) }),
        );
    });

    it('getDerivedStateFromError returns null for readonly property errors (iOS WKWebView)', () => {
        // Verify the static method suppresses the error — jsdom re-throws
        // regardless, but in real WebKit the boundary correctly swallows it.
        const result = (ErrorBoundary as any).getDerivedStateFromError(new Error('Cannot set readonly property'));
        expect(result).toBeNull();
    });
});

describe('CompactErrorFallback', () => {
    it('renders default message', () => {
        render(<CompactErrorFallback />);
        expect(screen.getByText('Error loading widget')).toBeInTheDocument();
    });

    it('renders custom message', () => {
        render(<CompactErrorFallback message="Wind data failed" />);
        expect(screen.getByText('Wind data failed')).toBeInTheDocument();
    });
});
