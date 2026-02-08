import React, { useRef, useEffect, useCallback } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

interface UPlotChartProps {
    options: Omit<uPlot.Options, 'width' | 'height'>;
    data: uPlot.AlignedData;
    className?: string;
}

/**
 * Lightweight React wrapper for uPlot.
 * Handles: container sizing via ResizeObserver, prop-driven updates, cleanup.
 */
export const UPlotChart: React.FC<UPlotChartProps> = ({ options, data, className }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<uPlot | null>(null);
    const optionsRef = useRef(options);
    optionsRef.current = options;

    // Stable resize handler
    const handleResize = useCallback(() => {
        if (chartRef.current && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                chartRef.current.setSize({ width: rect.width, height: rect.height });
            }
        }
    }, []);

    // Create/destroy chart instance when options change structurally
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const rect = container.getBoundingClientRect();
        const width = rect.width || 300;
        const height = rect.height || 200;

        // Destroy previous instance
        if (chartRef.current) {
            chartRef.current.destroy();
            chartRef.current = null;
        }

        const fullOpts: uPlot.Options = {
            ...options,
            width,
            height,
        };

        chartRef.current = new uPlot(fullOpts, data, container);

        // Observe container resizes
        const ro = new ResizeObserver(handleResize);
        ro.observe(container);

        return () => {
            ro.disconnect();
            if (chartRef.current) {
                chartRef.current.destroy();
                chartRef.current = null;
            }
        };
    }, [options]); // Recreate chart when options change

    // Update data without recreating chart
    useEffect(() => {
        if (chartRef.current) {
            chartRef.current.setData(data);
        }
    }, [data]);

    return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />;
};
