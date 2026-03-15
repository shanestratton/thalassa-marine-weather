# Contributing to Thalassa

## Development Setup

```bash
git clone <repo-url>
cd thalassa-marine-weather
npm install          # Also runs `husky` via prepare script
cp .env.example .env # Add your API keys
npm run dev          # Start dev server at localhost:5173
```

## Code Quality

### Pre-commit Hooks

Husky + lint-staged runs automatically on every commit:

- **ESLint** checks staged `.ts/.tsx` files (0 errors enforced)
- **Prettier** checks formatting on staged files

### Running Checks Manually

```bash
npm run lint         # ESLint (entire project)
npm run lint:fix     # Auto-fix what's possible
npm run format       # Reformat all files
npx tsc --noEmit     # TypeScript check
npm test             # Vitest (watch mode)
npx vitest run       # Vitest (CI mode, single run)
```

## Code Conventions

### File Organization

| Type       | Location      | Naming                                                 |
| ---------- | ------------- | ------------------------------------------------------ |
| Components | `components/` | PascalCase (e.g., `AnchorWatchPage.tsx`)               |
| Hooks      | `hooks/`      | camelCase with `use` prefix (`useKeyboardScroll.ts`)   |
| Services   | `services/`   | PascalCase (`WeatherScheduler.ts`)                     |
| Utilities  | `utils/`      | camelCase (`logger.ts`)                                |
| Tests      | `tests/`      | camelCase matching source (`weatherScheduler.test.ts`) |
| Types      | `types.ts`    | Centralized — add here, not in component files         |

### TypeScript

- **Strict mode** — no `// @ts-ignore` without justification
- **Avoid `any`** — use `unknown` + type guards, or `Record<string, unknown>`
- **Prefix unused params** with `_` (e.g., `_event`, `_unused`)
- **Use `createLogger`** instead of `console.log` in services

```typescript
// ✅ Good
import { createLogger } from '../utils/logger';
const log = createLogger('MyService');
log.info('Operation complete', { id });

// ❌ Bad
console.log('Operation complete', id);
```

### React Patterns

- **Hooks before early returns** — never call hooks conditionally
- **Use `useMemo`/`useCallback`** for expensive computations and callback props
- **Ref-stabilize callbacks** that are passed to memoized children
- **Extract hooks** when component state logic exceeds ~50 lines

### CSS

- TailwindCSS utility classes for all styling
- Design tokens in `theme.ts` — use `t.border.subtle`, `t.bg.card`, etc.
- Minimum touch target: 44×44px on interactive elements
- Typography floor: 11px minimum font size

## Testing

### Writing Tests

```bash
# Create test file matching the source
# services/WeatherScheduler.ts → tests/weatherScheduler.test.ts

npx vitest run tests/weatherScheduler.test.ts  # Run single file
```

### Test Structure

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('ModuleName', () => {
    describe('functionName()', () => {
        it('should handle the happy path', () => {
            // Arrange → Act → Assert
        });

        it('should handle edge case X', () => {
            // Test boundary conditions
        });
    });
});
```

### Mock Patterns

- Mock Supabase at module level with `vi.mock()`
- Use `vi.hoisted()` for mock variables referenced in `vi.mock()` factories
- Mock Capacitor plugins (`@capacitor/preferences`, etc.)

## Git Workflow

```bash
# Feature work
git checkout -b feature/my-feature
# ... make changes ...
git add -p                    # Stage selectively
git commit -m "feat: description"  # Pre-commit hook runs lint
git push origin feature/my-feature
# Open PR → CI runs lint + typecheck + tests + build
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `refactor:` — Code change that neither fixes a bug nor adds a feature
- `test:` — Adding or updating tests
- `docs:` — Documentation only
- `chore:` — Build process, CI, dependencies

## Architecture Notes

### Service Layer

Business logic lives in `services/`, never in components. Services are stateless singletons or static classes that can be tested independently.

### Weather Pipeline

```
WeatherKit (primary) → StormGlass (fallback) → OpenMeteo (fallback)
     ↓
WeatherContext (orchestration, caching, smart polling)
     ↓
WeatherScheduler (pure functions: interval selection, storm detection)
```

### Offline Support

All mutations go through an offline queue (`services/shiplog/OfflineQueue.ts`). When the device comes back online, queued operations sync automatically.
