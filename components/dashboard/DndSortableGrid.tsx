/**
 * DndSortableGrid — Lazy-loaded @dnd-kit wrapper for widget reordering.
 *
 * This component is loaded via React.lazy() so the 185KB @dnd-kit bundle
 * only downloads when the dashboard actually mounts, not at app startup.
 */
import React from 'react';
import { DndContext, closestCenter, useSensor, useSensors, PointerSensor, TouchSensor } from '@dnd-kit/core';
import { arrayMove, SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripIcon } from '../Icons';

interface DndSortableGridProps {
    items: string[];
    onReorder: (newOrder: string[]) => void;
    children: (id: string) => React.ReactNode;
}

const SortableMetricTile: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 50 : 1,
        opacity: isDragging ? 0.6 : 1,
        position: 'relative' as const,
    };

    return (
        <div ref={setNodeRef} style={style} className="h-full relative group/tile">
            {children}
            <div
                {...attributes}
                {...listeners}
                className="absolute top-1.5 right-1.5 p-1.5 text-white/60 hover:text-white/80 bg-black/10 hover:bg-sky-500/80 rounded-lg transition-all cursor-grab active:cursor-grabbing z-30 opacity-40 group-hover/tile:opacity-100 md:opacity-0 md:group-hover/tile:opacity-100"
                title="Drag to reorder"
            >
                <GripIcon className="w-3 h-3" />
            </div>
        </div>
    );
};

const DndSortableGrid: React.FC<DndSortableGridProps> = ({ items, onReorder, children }) => {
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 100, tolerance: 5 } }),
    );

    const handleDragEnd = (event: any) => {
        const { active, over } = event;
        if (active && over && active.id !== over.id) {
            const oldIndex = items.indexOf(active.id);
            const newIndex = items.indexOf(over.id);
            onReorder(arrayMove(items, oldIndex, newIndex));
        }
    };

    return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={items} strategy={rectSortingStrategy}>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {items.map((id) => (
                        <SortableMetricTile key={id} id={id}>
                            {children(id)}
                        </SortableMetricTile>
                    ))}
                </div>
            </SortableContext>
        </DndContext>
    );
};

export default DndSortableGrid;
