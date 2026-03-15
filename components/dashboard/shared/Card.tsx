import React from 'react';
export const Card: React.FC<
    React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode; className?: string }
> = ({ children, className = '', ...rest }) => (
    <div className={`bg-slate-900 border border-white/10 rounded-2xl p-6 shadow-2xl relative ${className}`} {...rest}>
        {children}
    </div>
);
