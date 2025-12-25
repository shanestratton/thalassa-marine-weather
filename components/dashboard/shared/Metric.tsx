import React from 'react';
export const Metric = ({ icon, label, value, subValue, isEstimated }: { icon: React.ReactNode, label: string, value: string | React.ReactNode, subValue?: string | React.ReactNode, isEstimated?: boolean }) => (
  <div className="flex flex-col items-center justify-center text-center p-2">
    <div className="mb-2 text-sky-300">{icon}</div>
    <span className="text-xs text-slate-300 uppercase tracking-wider mb-1">{label}</span>
    <span className={`text-xl font-semibold drop-shadow-md ${isEstimated ? 'text-yellow-400' : 'text-white'}`}>{value}</span>
    {subValue && <span className="text-xs text-slate-400 mt-1">{subValue}</span>}
    {isEstimated && <span className="text-[9px] text-yellow-500 uppercase font-bold mt-1 tracking-widest">Est.</span>}
  </div>
);