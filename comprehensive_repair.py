
import re
import sys

file_path = 'components/dashboard/HeroSlide.tsx'

def repair_content(content):
    # Matches "word - word" or "word - number" or "number - number" etc.
    # Basically matches space-hyphen-space and removes the spaces around the hyphen.
    # We need to be careful not to break valid JS like "a - b".
    # However, inside className strings, " - " is almost certainly a bug in this context.
    # The errors look like `className={... py - 1.5 ...}`.
    
    # Strategy: Look for specific broken strings first to be safe, then maybe a generic one if needed.
    # Actually, almost all Tailwind classes with hyphens are being mangled.
    
    replacements = [
        (r'py - 1\.5', 'py-1.5'),
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
        (r'rounded - full', 'rounded-full'),
        (r'transition - all', 'transition-all'),
        (r'duration - 300', 'duration-300'),
        (r'w - 1\.5', 'w-1.5'),
        (r'h - 1\.5', 'h-1.5'),
        (r'w - 1', 'w-1'),
        (r'h - 1', 'h-1'),
        (r'bg - white', 'bg-white'),
        (r'items - start', 'items-start'),
        (r'text - left', 'text-left'),
        (r'min - h - 0', 'min-h-0'),
        (r'text - center', 'text-center'),
        (r'items - end', 'items-end'),
        (r'text - right', 'text-right'),
        (r'text - slate', 'text-slate'),
        (r'tracking - widest', 'tracking-widest'),
        (r'bg - red', 'bg-red'),
        (r'text - red', 'text-red'),
        (r'tracking - tighter', 'tracking-tighter'),
        (r'text - gray', 'text-gray'),
        (r'mt - auto', 'mt-auto'),
        (r'pt - 1', 'pt-1'),
        (r'text - purple', 'text-purple'),
        (r'leading - none', 'leading-none'),
        (r'mt - 0', 'mt-0'),
        (r'mt - 1', 'mt-1'),
        (r'text - cyan', 'text-cyan'),
        (r'bg - orange', 'bg-orange'),
        (r'border - orange', 'border-orange'),
        (r'text - orange', 'text-orange'),
        (r'h - full', 'h-full'),
        (r'bg - sky', 'bg-sky'),
        
        # Generic catch-all for remaining " - " inside classNames? 
        # It's risky to do global replace of " - " -> "-".
        # Let's add more specific ones from the log if possible, or use a regex regarding class names.
        
        # Additional ones noticed in previous turns or logs
        (r'rounded - lg', 'rounded-lg'),
        (r'border - sky', 'border-sky'),
        (r'text - sky', 'text-sky'),
        (r'bg - amber', 'bg-amber'),
        (r'text - amber', 'text-amber'),
        (r'border - amber', 'border-amber'),
        
        # Grid/Flex
        (r'flex - col', 'flex-col'),
        (r'flex - row', 'flex-row'),
        (r'col - span', 'col-span'),
        (r'justify - between', 'justify-between'),
        
        # Misc
        (r'snap - start', 'snap-start'),
        (r'shrink - 0', 'shrink-0'),
        (r'rounded - 3xl', 'rounded-3xl'),
        (r'backdrop - blur', 'backdrop-blur'),
        (r'border - white', 'border-white'),
        (r'inset - 0', 'inset-0'),
        (r'z - 0', 'z-0'),
        (r'z - 10', 'z-10'),
        (r'z - 20', 'z-20'),
        (r'opacity - ', 'opacity-'),
        
        # Spacing
        (r'px - ', 'px-'), 
        (r'py - ', 'py-'),
        (r'pt - ', 'pt-'),
        (r'pb - ', 'pb-'),
        (r'pl - ', 'pl-'),
        (r'pr - ', 'pr-'),
        (r'mt - ', 'mt-'),
        (r'mb - ', 'mb-'),
        (r'ml - ', 'ml-'),
        (r'mr - ', 'mr-'),
        (r'gap - ', 'gap-'),
        
        # Sizes
        (r'w - ', 'w-'),
        (r'h - ', 'h-'),
        (r'min - w - ', 'min-w-'),
        (r'min - h - ', 'min-h-'),
        (r'max - w - ', 'max-w-'),
        (r'max - h - ', 'max-h-'),
        
        # Text
        (r'text - \[', 'text-['),
        (r'text - ', 'text-'),
        (r'font - ', 'font-'),
        (r'uppercase', 'uppercase'), # Safe
        
        # Borders/Bg
        (r'bg - ', 'bg-'),
        (r'border - ', 'border-'),
        (r'rounded - ', 'rounded-'),
        
        # Transform
        (r'translate - ', 'translate-'),
        (r'rotate - ', 'rotate-'),
        (r'scale - ', 'scale-'),
        
        # Animate
        (r'animate - ', 'animate-'),
        (r'duration - ', 'duration-'),
        (r'delay - ', 'delay-'),
        (r'ease - ', 'ease-'),
        
        # Shadows
        (r'shadow - ', 'shadow-'),
        (r'drop - shadow - ', 'drop-shadow-'),
        
        # New findings from grep
        (r'backdrop - blur - md', 'backdrop-blur-md'),
        (r'border - white / 10', 'border-white/10'),
        (r'bg - black / 20', 'bg-black/20'),
        (r'bg - gradient - to - br', 'bg-gradient-to-br'),
        (r'text - slate - 400', 'text-slate-400'),
        (r'text - orange - 200', 'text-orange-200'),
        (r'tracking - \[0\.2em\]', 'tracking-[0.2em]'),
        (r'whitespace - nowrap', 'whitespace-nowrap'),
        (r'items - baseline', 'items-baseline'),
        (r'pointer - events - auto', 'pointer-events-auto'),
        (r'translate - y - 1', 'translate-y-1'),
        (r'bg - black / 40', 'bg-black/40'),
        (r'border - white / 5', 'border-white/5'),
        (r'text - blue - 400', 'text-blue-400'),
        (r'text - emerald - 400', 'text-emerald-400'),
        (r'translate - y', 'translate-y'),
        
        # Catch cases where the word before hyphen is already clean but space follows
        # e.g. "text-slate - 400"
        (r'([a-z]+) - ([0-9]+)', r'\1-\2'),  # word - number -> word-number
        (r'([a-z]+) - ([a-z]+)', r'\1-\2'),  # word - word -> word-word
        (r' / ', '/'), # Fix " / " opacity/fraction separators
    ]

    # Apply specific ones first
    for pattern, repl in replacements:
        content = re.sub(pattern, repl, content)
        
    # Final cleanup: " - " to "-" specifically within obvious tailwind constructs if missed
    # Matches: space hyphen space followed by a digit or letter, preceded by a letter/digit
    # This is a bit recursive, so we'll just rely on the exhaustive list above which covers 
    # essentially all Tailwind prefixes.
    
    return content

try:
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    new_content = repair_content(content)

    if new_content == content:
        print("No changes made.")
    else:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        print("File repaired successfully.")

except Exception as e:
    print(f"Error: {e}")
