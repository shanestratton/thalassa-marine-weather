import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModalSheet } from '../../components/ui/ModalSheet';
import { StoresCategoryGrid } from '../../components/vessel/inventory/StoresCategoryGrid';
import type { InventoryCategory } from '../../types';
import '../../index.css';

function Fixture() {
    const [category, setCategory] = useState<InventoryCategory>('Provisions');
    return (
        <main className="h-dvh bg-slate-950 p-4 text-white">
            <h1 className="text-xl font-bold">Ship’s Stores</h1>
            {/* Match the real Add/Edit/scanned-item sheet and its content
                padding. Selection is local state: no inventory or account I/O. */}
            <ModalSheet isOpen title="Add item" onClose={() => {}}>
                <div className="space-y-2">
                    <div>
                        <label className="text-label font-bold text-gray-400 uppercase tracking-widest">Category</label>
                        <StoresCategoryGrid value={category} onChange={setCategory} />
                    </div>
                    <p className="pt-2 text-xs text-slate-400">
                        Selected: <output aria-label="Selected category">{category}</output>
                    </p>
                </div>
            </ModalSheet>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
