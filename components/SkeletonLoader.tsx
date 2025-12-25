import React from 'react';

export const SkeletonDashboard = () => {
  return (
    <div className="w-full max-w-5xl mx-auto pb-20 space-y-6 px-2 md:px-0">
      
      {/* Hero Section Skeleton */}
      <div className="flex flex-col md:flex-row items-end md:items-center justify-between mb-8 px-4 mt-4 animate-pulse">
        <div className="max-w-2xl w-full">
           <div className="flex items-center space-x-3 mb-4">
                <div className="h-6 w-32 bg-sky-500/20 rounded-full border border-sky-500/10"></div>
                <div className="h-4 w-24 bg-white/10 rounded"></div>
           </div>
           
           <div className="h-24 w-40 bg-white/10 rounded-3xl mb-4"></div>
           
           <div className="flex items-center gap-3 mb-6">
                <div className="h-8 w-8 bg-white/10 rounded-full"></div>
                <div className="h-8 w-48 bg-white/10 rounded-xl"></div>
           </div>

           {/* Boating Narrative Skeleton */}
           <div className="mt-4 bg-slate-900/40 border border-white/5 rounded-2xl p-4 w-full md:w-3/4">
               <div className="flex items-start gap-3">
                   <div className="h-8 w-8 rounded-full bg-sky-500/10"></div>
                   <div className="space-y-2 flex-1">
                       <div className="h-3 w-24 bg-sky-500/10 rounded"></div>
                       <div className="h-3 w-full bg-white/5 rounded"></div>
                       <div className="h-3 w-2/3 bg-white/5 rounded"></div>
                   </div>
               </div>
           </div>
        </div>
        
        <div className="mt-6 md:mt-0 flex flex-col items-end space-y-2 w-full md:w-auto">
             <div className="h-4 w-24 bg-white/10 rounded"></div>
             <div className="h-10 w-32 bg-white/10 rounded-xl"></div>
        </div>
      </div>

      {/* Vessel Status & Tides Skeleton */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 px-2">
          <div className="h-24 bg-slate-900/40 border border-white/5 rounded-3xl animate-pulse"></div>
          <div className="h-24 bg-slate-900/40 border border-white/5 rounded-3xl animate-pulse"></div>
      </div>

      {/* Primary Metrics Grid Skeleton */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 px-2">
        {[...Array(4)].map((_, i) => (
             <div key={i} className="h-32 bg-slate-900/40 border border-white/5 rounded-3xl p-6 flex flex-col items-center justify-center gap-3 animate-pulse">
                 <div className="h-6 w-6 bg-sky-500/20 rounded-full"></div>
                 <div className="h-3 w-16 bg-white/10 rounded"></div>
                 <div className="h-8 w-12 bg-white/10 rounded"></div>
             </div>
        ))}
      </div>

      {/* Detailed Wind Analysis Skeleton */}
      <div className="px-2">
        <div className="h-48 bg-slate-900/40 border border-white/5 rounded-3xl p-6 animate-pulse">
             <div className="flex items-center justify-between h-full">
                 <div className="flex items-center gap-6">
                     <div className="w-20 h-20 rounded-full border-4 border-white/5 bg-white/5"></div>
                     <div className="space-y-2">
                         <div className="h-6 w-32 bg-white/10 rounded"></div>
                         <div className="h-4 w-20 bg-white/5 rounded"></div>
                     </div>
                 </div>
                 <div className="flex-1 ml-12 space-y-4 hidden md:block">
                     <div className="h-4 w-full bg-white/5 rounded"></div>
                     <div className="h-4 w-2/3 bg-white/5 rounded"></div>
                 </div>
             </div>
        </div>
      </div>

      {/* Forecast Chart Skeleton */}
      <div className="mx-2">
          <div className="h-80 bg-slate-900/40 border border-white/5 rounded-3xl p-6 animate-pulse flex flex-col gap-4">
              <div className="flex justify-between">
                  <div className="h-6 w-32 bg-white/10 rounded"></div>
                  <div className="h-8 w-24 bg-white/10 rounded-lg"></div>
              </div>
              <div className="flex-1 bg-white/5 rounded-xl opacity-20 relative overflow-hidden">
                  <div className="absolute bottom-0 left-0 right-0 top-0 bg-gradient-to-t from-sky-500/10 to-transparent"></div>
              </div>
          </div>
      </div>
      
      {/* Consolidated Breakdown List Skeleton */}
      <div className="px-2 space-y-3">
          <div className="h-6 w-40 bg-white/10 rounded ml-2 animate-pulse"></div>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-3 px-2">
              {[...Array(7)].map((_, idx) => (
                  <div key={idx} className="bg-slate-900/40 rounded-2xl p-3 border border-white/5 h-56 animate-pulse flex flex-col items-center justify-between">
                       <div className="h-4 w-12 bg-white/10 rounded mb-2"></div>
                       <div className="h-8 w-8 bg-white/10 rounded-full mb-2"></div>
                       <div className="h-6 w-10 bg-white/10 rounded mb-4"></div>
                       <div className="w-full space-y-2">
                           <div className="h-3 w-full bg-white/5 rounded"></div>
                           <div className="h-3 w-full bg-white/5 rounded"></div>
                       </div>
                  </div>
              ))}
          </div>
      </div>
    </div>
  );
};