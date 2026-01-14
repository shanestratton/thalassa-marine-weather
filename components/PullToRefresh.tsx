import React, { useState } from 'react';

interface PullToRefreshProps {
    onRefresh: () => void;
    children: React.ReactNode;
    disabled?: boolean;
}

export const PullToRefresh: React.FC<PullToRefreshProps> = ({ onRefresh, children, disabled }) => {
    const [startY, setStartY] = useState(0);
    const [pullDistance, setPullDistance] = useState(0);
    const threshold = 120;
    const scrollRef = React.useRef<HTMLDivElement>(null);

    const handleTouchStart = (e: React.TouchEvent) => {
        if (disabled) return;
        if (scrollRef.current && scrollRef.current.scrollTop <= 1) {
            setStartY(e.touches[0].clientY);
        }
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        if (startY > 0 && scrollRef.current && scrollRef.current.scrollTop <= 1) {
            const currentY = e.touches[0].clientY;
            const diff = currentY - startY;

            if (diff > 0) {
                // Prevent default specifically when pulling down to avoid browser refresh/scroll
                if (diff < 200) e.stopPropagation();
                setPullDistance(Math.min(diff * 0.5, 150));
            }
        }
    };

    const handleTouchEnd = () => {
        if (pullDistance > threshold) {
            onRefresh();
        }
        setStartY(0);
        setPullDistance(0);
    };

    return (
        <div
            id="app-scroll-container"
            ref={scrollRef}
            className={`relative h-full ${disabled ? 'overflow-hidden' : 'overflow-y-auto'}`}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
        >
            {pullDistance > 20 && <div className="animate-spin rounded-full h-8 w-8 border-4 border-sky-400 border-t-transparent shadow-lg filter drop-shadow-[0_0_8px_rgba(56,189,248,0.8)]"></div>}
            <div style={{ transform: `translateY(${pullDistance}px)`, transition: startY === 0 ? 'transform 0.3s ease-out' : 'none' }} className={`flex-grow flex flex-col ${disabled ? 'h-full' : 'min-h-[101%]'}`}>
                {children}
            </div>
        </div>
    );
};
