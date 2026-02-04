/**
 * @fileoverview Tests for ErrorBoundary component
 * Tests error catching, fallback UI rendering, and recovery behavior
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary, CompactErrorFallback, withErrorBoundary } from '../components/ErrorBoundary';

// Component that throws an error
const ThrowingComponent: React.FC<{ shouldThrow?: boolean }> = ({ shouldThrow = true }) => {
    if (shouldThrow) {
        throw new Error('Test error message');
    }
    return <div data-testid="child-content">Child rendered successfully</div>;
};

// Component that works fine
const WorkingComponent: React.FC = () => (
    <div data-testid="working-content">Working component</div>
);

describe('ErrorBoundary', () => {
    // Suppress console.error during tests since we're testing error handling
    const originalError = console.error;
    beforeEach(() => {
        console.error = vi.fn();
    });
    afterEach(() => {
        console.error = originalError;
    });

    describe('error catching', () => {
        it('should catch errors in child components and display fallback UI', () => {
            render(
                <ErrorBoundary boundaryName="TestBoundary">
                    <ThrowingComponent />
                </ErrorBoundary>
            );

            expect(screen.getByText('Something went wrong')).toBeInTheDocument();
            expect(screen.queryByTestId('child-content')).not.toBeInTheDocument();
        });

        it('should render children normally when no error occurs', () => {
            render(
                <ErrorBoundary>
                    <WorkingComponent />
                </ErrorBoundary>
            );

            expect(screen.getByTestId('working-content')).toBeInTheDocument();
            expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
        });

        it('should display error message in fallback', () => {
            render(
                <ErrorBoundary>
                    <ThrowingComponent />
                </ErrorBoundary>
            );

            expect(screen.getByText(/Test error message/)).toBeInTheDocument();
        });

        it('should display boundary name in fallback', () => {
            render(
                <ErrorBoundary boundaryName="MapWidget">
                    <ThrowingComponent />
                </ErrorBoundary>
            );

            expect(screen.getByText(/Error in MapWidget/)).toBeInTheDocument();
        });
    });

    describe('custom fallback', () => {
        it('should render custom fallback when provided', () => {
            render(
                <ErrorBoundary fallback={<div data-testid="custom-fallback">Custom error UI</div>}>
                    <ThrowingComponent />
                </ErrorBoundary>
            );

            expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
            expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
        });
    });

    describe('error callback', () => {
        it('should call onError callback when error is caught', () => {
            const onError = vi.fn();

            render(
                <ErrorBoundary onError={onError}>
                    <ThrowingComponent />
                </ErrorBoundary>
            );

            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls[0][0].message).toBe('Test error message');
        });
    });

    describe('retry functionality', () => {
        it('should show Try Again button', () => {
            render(
                <ErrorBoundary>
                    <ThrowingComponent />
                </ErrorBoundary>
            );

            expect(screen.getByText('Try Again')).toBeInTheDocument();
        });

        it('should attempt to re-render children when retry is clicked', () => {
            let throwError = true;
            const ConditionalThrow = () => {
                if (throwError) throw new Error('Test');
                return <div data-testid="success">Success!</div>;
            };

            render(
                <ErrorBoundary>
                    <ConditionalThrow />
                </ErrorBoundary>
            );

            // Should show error state
            expect(screen.getByText('Something went wrong')).toBeInTheDocument();

            // Fix the component
            throwError = false;

            // Click retry
            fireEvent.click(screen.getByText('Try Again'));

            // Should now render successfully
            expect(screen.getByTestId('success')).toBeInTheDocument();
        });
    });
});

describe('CompactErrorFallback', () => {
    it('should render with default message', () => {
        render(<CompactErrorFallback />);
        expect(screen.getByText('Error loading widget')).toBeInTheDocument();
    });

    it('should render with custom message', () => {
        render(<CompactErrorFallback message="Custom error message" />);
        expect(screen.getByText('Custom error message')).toBeInTheDocument();
    });
});

describe('withErrorBoundary HOC', () => {
    it('should wrap component with error boundary', () => {
        const WrappedWorking = withErrorBoundary(WorkingComponent);

        render(<WrappedWorking />);

        expect(screen.getByTestId('working-content')).toBeInTheDocument();
    });

    it('should catch errors in wrapped component', () => {
        const WrappedThrowing = withErrorBoundary(ThrowingComponent);

        render(<WrappedThrowing shouldThrow={true} />);

        expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('should use component name as boundary name', () => {
        // Create named component
        const NamedComponent: React.FC = () => {
            throw new Error('Test');
        };
        NamedComponent.displayName = 'MyNamedWidget';

        const Wrapped = withErrorBoundary(NamedComponent);

        render(<Wrapped />);

        expect(screen.getByText(/Error in MyNamedWidget/)).toBeInTheDocument();
    });
});
