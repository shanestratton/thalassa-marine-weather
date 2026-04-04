/**
 * ShimmerBlock — Premium skeleton loading component for Thalassa.
 *
 * Replaces bare spinners with content-shaped loading placeholders
 * that match the layout of the content being loaded.
 *
 * Usage:
 *   <ShimmerBlock variant="card" />
 *   <ShimmerBlock variant="list" rows={5} />
 *   <ShimmerBlock variant="hero" />
 */
import React from 'react';

interface ShimmerBlockProps {
    /** Shape variant */
    variant?: 'card' | 'list' | 'hero' | 'text' | 'inline';
    /** Number of rows for list variant */
    rows?: number;
    /** Custom height */
    height?: string;
    /** Custom width */
    width?: string;
    /** Additional className */
    className?: string;
}

/** Single shimmer bar */
const Bar: React.FC<{ w?: string; h?: string; className?: string; rounded?: string }> = ({
    w = 'w-full',
    h = 'h-3',
    className = '',
    rounded = 'rounded-md',
}) => (
    <div
        className={`${w} ${h} ${rounded} bg-white/[0.06] shimmer-block ${className}`}
        style={{
            backgroundImage:
                'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.04) 40%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 60%, transparent 100%)',
            backgroundSize: '200% 100%',
            animation: 'shimmer-sweep 1.8s ease-in-out infinite',
        }}
    />
);

/** Card skeleton — matches glassmorphic card layout */
const CardSkeleton: React.FC = () => (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-3">
            <Bar w="w-10" h="h-10" rounded="rounded-xl" />
            <div className="flex-1 space-y-2">
                <Bar w="w-2/3" h="h-3.5" />
                <Bar w="w-1/3" h="h-2.5" />
            </div>
        </div>
        <Bar w="w-full" h="h-2.5" />
        <Bar w="w-4/5" h="h-2.5" />
    </div>
);

/** List skeleton — matches OfficeRow layout */
const ListSkeleton: React.FC<{ rows: number }> = ({ rows }) => (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden divide-y divide-white/[0.04]">
        {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
                <Bar w="w-8" h="h-8" rounded="rounded-lg" />
                <div className="flex-1 space-y-1.5">
                    <Bar w={i % 2 === 0 ? 'w-1/2' : 'w-2/5'} h="h-3" />
                    <Bar w="w-1/4" h="h-2" />
                </div>
                <Bar w="w-5" h="h-5" rounded="rounded-md" />
            </div>
        ))}
    </div>
);

/** Hero skeleton — matches dashboard hero card */
const HeroSkeleton: React.FC = () => (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between">
            <Bar w="w-1/3" h="h-4" />
            <Bar w="w-16" h="h-6" rounded="rounded-full" />
        </div>
        <Bar w="w-2/3" h="h-8" rounded="rounded-lg" />
        <div className="flex gap-3">
            <Bar w="w-1/4" h="h-16" rounded="rounded-xl" />
            <Bar w="w-1/4" h="h-16" rounded="rounded-xl" />
            <Bar w="w-1/4" h="h-16" rounded="rounded-xl" />
            <Bar w="w-1/4" h="h-16" rounded="rounded-xl" />
        </div>
    </div>
);

/** Text skeleton — paragraph block */
const TextSkeleton: React.FC = () => (
    <div className="space-y-2.5">
        <Bar w="w-full" h="h-3" />
        <Bar w="w-11/12" h="h-3" />
        <Bar w="w-4/5" h="h-3" />
        <Bar w="w-3/5" h="h-3" />
    </div>
);

/** Inline skeleton — single line */
const InlineSkeleton: React.FC<{ width?: string; height?: string }> = ({ width = 'w-20', height = 'h-3' }) => (
    <Bar w={width} h={height} />
);

export const ShimmerBlock: React.FC<ShimmerBlockProps> = ({
    variant = 'card',
    rows = 4,
    height,
    width,
    className = '',
}) => (
    <div className={className} style={{ animation: 'bio-fadein 0.3s ease' }}>
        {variant === 'card' && <CardSkeleton />}
        {variant === 'list' && <ListSkeleton rows={rows} />}
        {variant === 'hero' && <HeroSkeleton />}
        {variant === 'text' && <TextSkeleton />}
        {variant === 'inline' && <InlineSkeleton width={width} height={height} />}
    </div>
);

/** CSS injection — adds the shimmer sweep keyframe */
export const ShimmerStyles: React.FC = () => (
    <style>{`
        @keyframes shimmer-sweep {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }
    `}</style>
);
