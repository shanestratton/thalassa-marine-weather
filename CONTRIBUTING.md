# Contributing to Thalassa

Thank you for contributing to Thalassa! Follow these guidelines to keep the codebase clean and consistent.

## Development Setup

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Run tests
npm test

# Type check
npx tsc --noEmit --skipLibCheck

# Lint
npx eslint .
```

## Code Standards

### Components

- **Max 500 lines** — extract sub-components if growing beyond this
- Use `React.memo()` on components receiving stable props
- Use `useCallback` and `useMemo` for expensive computations
- Place hooks before any early returns (React Rules of Hooks)

### TypeScript

- Avoid `as any` — use proper types or `unknown` with type guards
- Add return types on all exported functions
- Use `eslint-disable-next-line` with specific rule names, never bare `eslint-disable`

### Styling

- Use Tailwind CSS utility classes
- Dark theme only — all backgrounds should be slate-900/950
- Minimum touch target: 44x44px for interactive elements
- Minimum font size: 11px (`text-[11px]`)
- Color contrast: `text-gray-300` minimum for body text on dark backgrounds

### Accessibility

- All icon-only buttons must have `aria-label`
- Use semantic HTML (`<nav>`, `<main>`, `<section>`)
- Provide `role="status"` and `aria-live="polite"` for dynamic content
- Ensure keyboard navigability on all interactive elements

### Services

- Use `createLogger('ServiceName')` for debug logging
- Cache API responses with TTL where appropriate
- Never expose API keys in client code — use Supabase Edge Functions

### Testing

- Every service should have a corresponding `.test.ts` file
- Use `describe` / `it` blocks with clear test names
- Mock external dependencies (Supabase, fetch, GPS)

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new weather overlay
fix: correct tide calculation for southern hemisphere
docs: update API documentation
a11y: add aria-labels to navigation buttons
refactor: extract TideGraph into separate component
test: add AIS guard zone edge case tests
devops: add Lighthouse CI configuration
```

## Pre-commit Hooks

Husky runs lint-staged on every commit:

- **ESLint** — catches errors and enforces code quality
- **Prettier** — formats code consistently

If your commit fails, run:

```bash
npx prettier --write <file>
npx eslint --fix <file>
```

## Branch Strategy

1. Branch from `master`
2. Make changes in a feature branch
3. Ensure `npm test` and `npx tsc --noEmit` pass
4. Submit a pull request

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for system diagrams and service documentation.
