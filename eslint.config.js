import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
    // Global ignores
    {
        ignores: [
            'dist/**',
            'build/**',
            '.next/**',
            'node_modules/**',
            'supabase/functions/**',
            'android/**',
            'ios/**',
            '*.config.*',
            'vite.config.*',
        ],
    },

    // Base JS recommended rules
    eslint.configs.recommended,

    // TypeScript recommended (type-aware rules disabled for speed)
    ...tseslint.configs.recommended,

    // React Hooks — only the classic two rules
    {
        plugins: {
            'react-hooks': reactHooks,
        },
        rules: {
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
        },
    },

    // Prettier — disables formatting rules that conflict
    eslintConfigPrettier,

    // Project-specific overrides
    {
        languageOptions: {
            globals: {
                // Browser globals
                window: 'readonly',
                document: 'readonly',
                navigator: 'readonly',
                localStorage: 'readonly',
                sessionStorage: 'readonly',
                fetch: 'readonly',
                console: 'readonly',
                setTimeout: 'readonly',
                setInterval: 'readonly',
                clearTimeout: 'readonly',
                clearInterval: 'readonly',
                requestAnimationFrame: 'readonly',
                cancelAnimationFrame: 'readonly',
                URL: 'readonly',
                URLSearchParams: 'readonly',
                AbortController: 'readonly',
                FormData: 'readonly',
                Blob: 'readonly',
                File: 'readonly',
                FileReader: 'readonly',
                Image: 'readonly',
                HTMLElement: 'readonly',
                HTMLCanvasElement: 'readonly',
                HTMLInputElement: 'readonly',
                HTMLTextAreaElement: 'readonly',
                HTMLDivElement: 'readonly',
                HTMLButtonElement: 'readonly',
                HTMLAnchorElement: 'readonly',
                HTMLImageElement: 'readonly',
                HTMLVideoElement: 'readonly',
                HTMLSelectElement: 'readonly',
                Event: 'readonly',
                MouseEvent: 'readonly',
                KeyboardEvent: 'readonly',
                TouchEvent: 'readonly',
                PointerEvent: 'readonly',
                CustomEvent: 'readonly',
                ResizeObserver: 'readonly',
                IntersectionObserver: 'readonly',
                MutationObserver: 'readonly',
                WebGLRenderingContext: 'readonly',
                WebGL2RenderingContext: 'readonly',
                CanvasRenderingContext2D: 'readonly',
                Performance: 'readonly',
                performance: 'readonly',
                DOMRect: 'readonly',
                DOMParser: 'readonly',
                Response: 'readonly',
                Request: 'readonly',
                Headers: 'readonly',
                Worker: 'readonly',
                MessageChannel: 'readonly',
                BroadcastChannel: 'readonly',
                TextEncoder: 'readonly',
                TextDecoder: 'readonly',
                structuredClone: 'readonly',
                crypto: 'readonly',
                queueMicrotask: 'readonly',
                alert: 'readonly',
                confirm: 'readonly',
                prompt: 'readonly',
                atob: 'readonly',
                btoa: 'readonly',
                location: 'readonly',
                history: 'readonly',
                self: 'readonly',
                globalThis: 'readonly',
                NodeJS: 'readonly',
                process: 'readonly',
                __dirname: 'readonly',
                Float32Array: 'readonly',
                Uint8Array: 'readonly',
                Uint16Array: 'readonly',
                Int32Array: 'readonly',
                ArrayBuffer: 'readonly',
                DataView: 'readonly',
                SharedArrayBuffer: 'readonly',
                Map: 'readonly',
                Set: 'readonly',
                WeakMap: 'readonly',
                WeakRef: 'readonly',
                FinalizationRegistry: 'readonly',
                Proxy: 'readonly',
                Reflect: 'readonly',
                Symbol: 'readonly',
                BigInt: 'readonly',
                Intl: 'readonly',
                // Capacitor
                Capacitor: 'readonly',
                // Service Worker / Cache API
                caches: 'readonly',
            },
        },
        rules: {
            // ── Errors (must fix) ──
            'no-unused-vars': 'off', // Use TS version instead
            '@typescript-eslint/no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_|^e$|^err$|^error$',
                destructuredArrayIgnorePattern: '^_',
                ignoreRestSiblings: true,
            }],
            'no-console': ['warn', {
                allow: ['warn', 'error', 'info', 'debug'],
            }],

            // ── Warnings (tech debt markers) ──
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-non-null-assertion': 'off',

            // ── Relaxed (pragmatic for existing codebase) ──
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/no-empty-object-type': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-unused-expressions': 'off',
            'no-empty': 'off',
            'prefer-const': 'warn',
            'no-fallthrough': 'off',
            'no-case-declarations': 'off',
            'no-useless-catch': 'off',
            'no-useless-assignment': 'off',
            'preserve-caught-error': 'off',
            'no-unsafe-finally': 'warn',
            'no-constant-binary-expression': 'warn',
            '@typescript-eslint/prefer-as-const': 'warn',
        },
    },

    // Test file overrides — more permissive
    {
        files: ['tests/**/*.ts', 'tests/**/*.tsx', '**/*.test.ts', '**/*.test.tsx'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            'no-console': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
);
