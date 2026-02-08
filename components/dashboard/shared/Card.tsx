import React from 'react';
import { t } from '../../../theme';
export const Card: React.FC<React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode; className?: string }> = ({ children, className = "", ...rest }) => (
  <div className={`backdrop-blur-xl bg-slate-900/60 border border-white/10 rounded-3xl p-6 shadow-2xl relative ${className}`} {...rest}>
    {children}
  </div>
);