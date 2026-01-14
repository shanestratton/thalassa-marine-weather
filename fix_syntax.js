
const fs = require('fs');
const path = './components/dashboard/HeroSlide.tsx';

try {
    let content = fs.readFileSync(path, 'utf8');

    // Regex to fix "word - word" inside className or general
    // We target specific known Tailwind classes to be safe
    const replacements = [
        [/px - 2/g, 'px-2'],
        [/py - 1\.5/g, 'py-1.5'],
        [/rounded - lg/g, 'rounded-lg'],
        [/text - \[9px\]/g, 'text-[9px]'],
        [/font - bold/g, 'font-bold'],
        [/tracking - wider/g, 'tracking-wider'],
        [/bg - black/g, 'bg-black'],
        [/min - w - 0/g, 'min-w-0'],
        [/flex - 1/g, 'flex-1'],
        [/items - center/g, 'items-center'],
        [/justify - center/g, 'justify-center'],
        [/gap - 1/g, 'gap-1'],
        [/overflow - hidden/g, 'overflow-hidden'],
        [/bg - emerald/g, 'bg-emerald'],
        [/text - emerald/g, 'text-emerald'],
        [/border - emerald/g, 'border-emerald'],
        [/bg - indigo/g, 'bg-indigo'],
        [/text - indigo/g, 'text-indigo'],
        [/border - indigo/g, 'border-indigo'],
        [/bg - sky/g, 'bg-sky'],
        [/text - sky/g, 'text-sky'],
        [/border - sky/g, 'border-sky'],
        [/bg - amber/g, 'bg-amber'],
        [/text - amber/g, 'text-amber'],
        [/border - amber/g, 'border-amber'],
        [/bg - white/g, 'bg-white'],
        [/rounded - full/g, 'rounded-full'],
        [/transition - all/g, 'transition-all'],
        [/duration - 300/g, 'duration-300'],
        [/w - 1\.5/g, 'w-1.5'],
        [/h - 1\.5/g, 'h-1.5'],
        [/w - 1/g, 'w-1'],
        [/h - 1/g, 'h-1']
    ];

    replacements.forEach(([regex, replacement]) => {
        content = content.replace(regex, replacement);
    });

    fs.writeFileSync(path, content, 'utf8');
    console.log('Successfully repaired HeroSlide.tsx');
} catch (err) {
    console.error('Error repairing file:', err);
    process.exit(1);
}
