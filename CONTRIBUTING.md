# Contributing to Thalassa

## Code Conventions

### TypeScript

- **Zero `as any`** — All production code is fully typed
- **Zero `@ts-ignore`** — Use proper type narrowing instead
- **Centralized types** — Add domain interfaces to `types.ts`
- **Strict mode** — `tsc --noEmit` must pass with zero errors

### Component Patterns

```tsx
// ✅ Good: Hook extraction for complex logic
const { data, loading, actions } = useDashboardController();

// ✅ Good: Service layer for business logic  
await ShipLogService.createEntry(entry);

// ❌ Bad: Fetch calls directly in components
// ❌ Bad: Business logic in event handlers
```

### Error Handling

- All `catch {}` blocks must have an inline comment explaining **why** silence is appropriate
- Use `log.error()` or `log.warn()` for unexpected failures
- Use silent catches only for: GPS fallbacks, localStorage corruption, platform polyfills, non-critical persistence
- Use `getErrorMessage(error)` to safely extract error messages

```typescript
// ✅ Good: Documented silent catch
} catch {
    /* Reverse geocode failed — fall back to coordinate-based name */
    name = `WP ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

// ❌ Bad: Undocumented silent catch
} catch { }
```

### Accessibility

- All interactive elements must be `<button>` or `<a>`, never clickable `<div>`s
- Modal overlays require `role="dialog"`, `aria-modal="true"`, and `aria-label`
- Loading states use `role="alert"` + `aria-live="assertive"`
- Toggle buttons use `aria-pressed`
- Icon-only buttons require `aria-label`

### File Organization

| Directory | Purpose |
|-----------|---------|
| `components/` | React UI components, organized by feature |
| `services/` | Business logic services (no React dependencies) |
| `hooks/` | Custom React hooks (bridge between services and UI) |
| `utils/` | Pure functions (unit conversions, math, formatting) |
| `context/` | React Context providers for global state |
| `types.ts` | Centralized TypeScript interfaces |

---

## Development Workflow

### Branch Strategy

1. Create a feature branch from `main`
2. Make changes with passing types (`npx tsc --noEmit`)
3. Run tests (`npm run test`)
4. Submit PR with description of changes

### Before Committing

```bash
npx tsc --noEmit           # TypeScript must be clean
npm run test               # All 325+ tests must pass
```

### Adding a New Feature

1. **Types first** — Define interfaces in `types.ts`
2. **Service layer** — Create a service in `services/` if needed
3. **Hook** — Extract complex logic into `hooks/`
4. **Component** — Build the UI component
5. **Tests** — Add unit tests for any pure functions or service logic

### Adding Tests

Place test files adjacent to the module they test:

```
utils/
├── units.ts         # Implementation
├── units.test.ts    # Tests
├── math.ts
├── math.test.ts
└── ...
```

Use Vitest with Testing Library:

```typescript
import { describe, it, expect } from 'vitest';
import { myFunction } from './myModule';

describe('myFunction', () => {
    it('handles the happy path', () => {
        expect(myFunction(input)).toBe(expected);
    });

    it('returns null for null input', () => {
        expect(myFunction(null)).toBeNull();
    });
});
```

---

## API Keys

| Service | Purpose | Required |
|---------|---------|----------|
| StormGlass | Primary weather data | Yes |
| Mapbox | Map tiles and geocoding | Yes |
| Gemini | AI voyage analysis | Optional |
| Supabase | Auth, database, sync | Optional |
| WorldTides | Tide predictions | Optional |
| OpenMeteo | Fallback weather | Optional |

Keys are set via `.env` file with `VITE_` prefix for Vite bundling.
