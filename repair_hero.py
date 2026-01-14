
import re
import os

file_path = 'components/dashboard/HeroSlide.tsx'

def repair_content(content):
    # extensive list of broken patterns observed
    replacements = [
        # Specific Badges
        (r'px - 2', 'px-2'),
        (r'py - 1\.5', 'py-1.5'),
        (r'rounded - lg', 'rounded-lg'),
        (r'text - \[9px\]', 'text-[9px]'),
        (r'font - bold', 'font-bold'),
        (r'tracking - wider', 'tracking-wider'),
        (r'bg - black', 'bg-black'),
        (r'min - w - 0', 'min-w-0'),
        (r'flex - 1', 'flex-1'),
        (r'items - center', 'items-center'),
        (r'justify - center', 'justify-center'),
        (r'gap - 1', 'gap-1'),
        (r'overflow - hidden', 'overflow-hidden'),
        
        # Colors
        (r'bg - emerald', 'bg-emerald'),
        (r'text - emerald', 'text-emerald'),
        (r'border - emerald', 'border-emerald'),
        (r'bg - indigo', 'bg-indigo'),
        (r'text - indigo', 'text-indigo'),
        (r'border - indigo', 'border-indigo'),
        (r'bg - sky', 'bg-sky'),
        (r'text - sky', 'text-sky'),
        (r'border - sky', 'border-sky'),
        (r'bg - amber', 'bg-amber'),
        (r'text - amber', 'text-amber'),
        (r'border - amber', 'border-amber'),
        (r'bg - white', 'bg-white'),
        (r'bg - blue', 'bg-blue'),
        (r'text - blue', 'text-blue'),
        (r'border - blue', 'border-blue'),
        (r'text - slate', 'text-slate'),
        (r'text - orange', 'text-orange'),
        (r'text - red', 'text-red'),
        (r'text - gray', 'text-gray'),
        (r'text - cyan', 'text-cyan'),
        (r'text - purple', 'text-purple'),
        (r'text - violet', 'text-violet'),
        (r'text - yellow', 'text-yellow'),
        (r'text - teal', 'text-teal'),
        
        # Dimensions / Layout
        (r'rounded - full', 'rounded-full'),
        (r'transition - all', 'transition-all'),
        (r'duration - 300', 'duration-300'),
        (r'w - 1\.5', 'w-1.5'),
        (r'h - 1\.5', 'h-1.5'),
        (r'w - 1', 'w-1'),
        (r'h - 1', 'h-1'),
        (r'w - 2\.5', 'w-2.5'),
        (r'h - 2\.5', 'h-2.5'),
        (r'w - 3\.5', 'w-3.5'),
        (r'h - 3\.5', 'h-3.5'),
        (r'w - 3', 'w-3'),
        (r'h - 3', 'h-3'),
        (r'w - 4', 'w-4'),
        (r'h - 4', 'h-4'),
        (r'w - full', 'w-full'),
        (r'h - auto', 'h-auto'),
        (r'h - full', 'h-full'),
        (r'min - h - 0', 'min-h-0'),
        (r'!h - full', '!h-full'),
        (r'!min - h - 0', '!min-h-0'),
        (r'min - h - \[', 'min-h-['),
        (r'min - w - \[', 'min-w-['), 
        
        # Flex / Grid
        (r'flex - col', 'flex-col'),
        (r'flex - row', 'flex-row'),
        (r'justify - between', 'justify-between'),
        (r'items - start', 'items-start'),
        (r'items - end', 'items-end'),
        (r'items - stretch', 'items-stretch'),
        (r'col - span', 'col-span'),
        
        # Spacing
        (r'px - 0\.5', 'px-0.5'),
        (r'pb - 0', 'pb-0'),
        (r'mb - 0\.5', 'mb-0.5'),
        (r'mt - 0\.5', 'mt-0.5'),
        (r'gap - 0\.5', 'gap-0.5'),
        (r'gap - 1\.5', 'gap-1.5'),
        (r'gap - 2', 'gap-2'),
        (r'gap - 3', 'gap-3'),
        (r'pt - 1', 'pt-1'),
        (r'pt - 4', 'pt-4'),
        (r'pt - 6', 'pt-6'),
        (r'px - 4', 'px-4'),
        (r'px - 6', 'px-6'),
        (r'px - 1\.5', 'px-1.5'),
        (r'py - 0\.5', 'py-0.5'),
        (r'pl - 1', 'pl-1'),
        (r'mb - 1', 'mb-1'),
        (r'mb - 2', 'mb-2'),
        (r'mt - auto', 'mt-auto'),

        # Typography
        (r'text - \[10px\]', 'text-[10px]'),
        (r'text - \[8px\]', 'text-[8px]'),
        (r'text - xs', 'text-xs'),
        (r'text - sm', 'text-sm'),
        (r'text - base', 'text-base'),
        (r'text - lg', 'text-lg'),
        (r'text - xl', 'text-xl'),
        (r'text - 2xl', 'text-2xl'),
        (r'text - 3xl', 'text-3xl'),
        (r'text - 4xl', 'text-4xl'),
        (r'text - 5xl', 'text-5xl'),
        (r'text - 6xl', 'text-6xl'),
        (r'font - black', 'font-black'),
        (r'font - extrabold', 'font-extrabold'),
        (r'font - medium', 'font-medium'),
        (r'font - mono', 'font-mono'),
        (r'tracking - widest', 'tracking-widest'),
        (r'tracking - tighter', 'tracking-tighter'),
        (r'tracking - tight', 'tracking-tight'),
        (r'tracking - \[0\.2em\]', 'tracking-[0.2em]'),
        (r'leading - none', 'leading-none'),
        (r'whitespace - nowrap', 'whitespace-nowrap'),
        (r'text - left', 'text-left'),
        (r'text - right', 'text-right'),
        (r'text - center', 'text-center'),
        
        # Misc
        (r'snap - start', 'snap-start'),
        (r'shrink - 0', 'shrink-0'),
        (r'rounded - 3xl', 'rounded-3xl'),
        (r'rounded - 2xl', 'rounded-2xl'),
        (r'rounded - xl', 'rounded-xl'),
        (r'backdrop - blur - md', 'backdrop-blur-md'),
        (r'backdrop - blur - sm', 'backdrop-blur-sm'),
        (r'border - white', 'border-white'),
        (r'border - t', 'border-t'),
        (r'border - r', 'border-r'),
        (r'border - b', 'border-b'),
        (r'bg - gradient - to - br', 'bg-gradient-to-br'),
        (r'opacity - 90', 'opacity-90'),
        (r'opacity - 70', 'opacity-70'),
        (r'opacity - 50', 'opacity-50'),
        (r'pointer - events - auto', 'pointer-events-auto'),
        (r'pointer - events - none', 'pointer-events-none'),
        (r'translate - y - 1', 'translate-y-1'),
        (r'translate - y - 1\.5', 'translate-y-1.5'),
        (r'translate - y - 2', 'translate-y-2'),
        (r'translate - x - 1/2', 'translate-x-1/2'),
        (r'drop - shadow - 2xl', 'drop-shadow-2xl'),
        (r'drop - shadow - md', 'drop-shadow-md'),
        (r'blur - 2xl', 'blur-2xl'),
        (r'z - 10', 'z-10'),
        (r'z - 20', 'z-20'),
        (r'z - 30', 'z-30'),
        (r'inset - 0', 'inset-0'),
        (r'inset - x - 4', 'inset-x-4'),
    ]

    for pattern, repl in replacements:
        content = re.sub(pattern, repl, content)
    return content

try:
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    original_len = len(content)
    new_content = repair_content(content)
    
    # Second pass to catch any lingering " - " that might handle cases like "border - white / 10"
    new_content = re.sub(r' / ', '/', new_content)
    # Be careful with / though, assume mostly used in tailwind opacity/fraction
    
    # Catching broad class names " - " inside template literals?
    # A generic "space hyphen space" to hyphen inside className strings is risky if not careful.
    # But for this file, it seems the issue is systemic.

    if len(new_content) == original_len and new_content == content:
        print("No changes needed.")
    else:
        print(f"Repaired file. Replaced {original_len} chars with {len(new_content)}.")
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
            
except Exception as e:
    print(f"Error: {e}")
