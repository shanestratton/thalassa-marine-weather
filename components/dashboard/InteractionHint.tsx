import React, { useEffect, useState } from 'react';

export const InteractionHint = () => {
    const [visible, setVisible] = useState(true);

    useEffect(() => {
        // Disappear after 5 seconds
        const timer = setTimeout(() => {
            setVisible(false);
        }, 5000);
        return () => clearTimeout(timer);
    }, []);

    if (!visible) return null;

    return (
        <div className="absolute inset-x-0 bottom-24 z-50 flex justify-center items-end pointer-events-none opacity-40 animate-pulse">
            <div className="flex flex-col items-center gap-2">
                {/* Finger / Hand Icon */}
                <svg
                    width="40"
                    height="40"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="white"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="drop-shadow-lg animate-bounce"
                >
                    <path d="M12 5v14M19 12l-7 7-7-7" />
                </svg>
                <span className="text-sm font-mono text-white/60 uppercase tracking-widest font-bold drop-shadow-md">Scroll for Details</span>
            </div>
        </div>
    );
};
