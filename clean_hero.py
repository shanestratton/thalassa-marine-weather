
import re
import sys

file_path = 'components/dashboard/HeroSlide.tsx'

try:
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    original_len = len(content)
    
    # Define replacements
    replacements = [
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
        (r'rounded - full', 'rounded-full'),
        (r'transition - all', 'transition-all'),
        (r'duration - 300', 'duration-300'),
        (r'w - 1\.5', 'w-1.5'),
        (r'h - 1\.5', 'h-1.5'),
        (r'w - 1', 'w-1'),
        (r'h - 1', 'h-1'),
        (r'snap - start', 'snap-start'),
        (r'shrink - 0', 'shrink-0'),
        (r'px - 0\.5', 'px-0.5'),
        (r'pb - 0', 'pb-0'),
        (r'flex - col', 'flex-col'),
        (r'rounded - 3xl', 'rounded-3xl'),
        (r'overflow - hidden', 'overflow-hidden'),
        (r'backdrop - blur - md', 'backdrop-blur-md'),
        (r'border - white', 'border-white'),
        (r'bg - gradient - to - br', 'bg-gradient-to-br'),
        (r'opacity - 90', 'opacity-90'),
        (r'tracking - widest', 'tracking-widest'),
        (r'leading - none', 'leading-none'),
        (r'text - slate - 400', 'text-slate-400'),
        (r'text - orange - 200', 'text-orange-200'),
        (r'font - extrabold', 'font-extrabold'),
        (r'text - sm', 'text-sm'),
        (r'text - xs', 'text-xs'),
        (r'tracking - \[0\.2em\]', 'tracking-[0.2em]'),
        (r'w - full', 'w-full'),
        (r'text - left', 'text-left'),
        (r'text - 2xl', 'text-2xl'),
        (r'text - 3xl', 'text-3xl'),
        (r'font - black', 'font-black'),
        (r'tracking - tighter', 'tracking-tighter'),
        (r'whitespace - nowrap', 'whitespace-nowrap'),
        (r'mb - 0\.5', 'mb-0.5'),
        (r'text - base', 'text-base'),
        (r'font - mono', 'font-mono'),
        (r'translate - y - 1', 'translate-y-1'),
        (r'items - start', 'items-start'),
        (r'items - end', 'items-end'),
        (r'text - center', 'text-center'),
        (r'text - right', 'text-right'),
        (r'min - h - 0', 'min-h-0'),
        (r'!h - full', '!h-full'),
        (r'!min - h - 0', '!min-h-0'),
        (r'justify - between', 'justify-between'),
        (r'pointer - events - auto', 'pointer-events-auto')
    ]

    for pattern, repl in replacements:
        content = re.sub(pattern, repl, content)

    if len(content) == original_len:
        print("No changes made (length unchanged).")
    else:
        print(f"Content changed! Old len: {original_len}, New len: {len(content)}")
        
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
        
    print("File written successfully.")

except Exception as e:
    print(f"Error: {e}")
