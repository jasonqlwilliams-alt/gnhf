---
name: gnhf-conventions
description: Development conventions and patterns for gnhf. TypeScript project with conventional commits.
---

# Gnhf Conventions

> Generated from [jasonqlwilliams-alt/gnhf](https://github.com/jasonqlwilliams-alt/gnhf) on 2026-08-30

## Overview

This skill teaches Claude the development patterns and conventions used in gnhf.

## Tech Stack

- **Primary Language**: TypeScript
- **Architecture**: type-based module organization
- **Test Location**: colocated
- **Test Framework**: vitest

## When to Use This Skill

Activate this skill when:
- Making changes to this repository
- Adding new features following established patterns
- Writing tests that match project conventions
- Creating commits with proper message format

## Commit Conventions

Follow these commit message conventions based on 27 analyzed commits.

### Commit Style: Conventional Commits

### Prefixes Used

- `fix`
- `chore`
- `feat`
- `ci`
- `docs`

### Message Guidelines

- Average message length: ~57 characters
- Keep first line concise and descriptive
- Use imperative mood ("Add feature" not "Added feature")


*Commit message example*

```text
fix(agents): surface Claude CLI exit errors (#190)
```

*Commit message example*

```text
docs: add captain-approved VISION.md (#197)
```

*Commit message example*

```text
feat(agents): add native Cursor CLI support (#203)
```

*Commit message example*

```text
chore(main): release gnhf 0.1.44 (#194)
```

*Commit message example*

```text
ci: require no-mistakes pipeline step attestation (#210)
```

*Commit message example*

```text
fix(agents): recover wrapped Pi JSON output (#195)
```

*Commit message example*

```text
Enable in-repo no-mistakes test evidence storage. (#204)
```

*Commit message example*

```text
chore(agents): use @AGENTS.md import instead of CLAUDE.md symlink (#205)
```

## Architecture

### Project Structure: Single Package

This project uses **type-based** module organization.

### Source Layout

```
src/
├── core/
├── utils/
```

### Configuration Files

- `.github/workflows/no-mistakes-required.yml`
- `package.json`

### Guidelines

- Group code by type (components, services, utils)
- Keep related functionality in the same type folder
- Avoid circular dependencies between type folders

## Code Style

### Language: TypeScript

### Naming Conventions

| Element | Convention |
|---------|------------|
| Files | camelCase |
| Functions | camelCase |
| Classes | PascalCase |
| Constants | SCREAMING_SNAKE_CASE |

### Import Style: Relative Imports

### Export Style: Named Exports


*Preferred import style*

```typescript
// Use relative imports
import { Button } from '../components/Button'
import { useAuth } from './hooks/useAuth'
```

*Preferred export style*

```typescript
// Use named exports
export function calculateTotal() { ... }
export const TAX_RATE = 0.1
export interface Order { ... }
```

## Testing

### Test Framework: vitest

### File Pattern: `*.test.ts`

### Test Types

- **Unit tests**: Test individual functions and components in isolation
- **Integration tests**: Test interactions between multiple components/services
- **E2e tests**: Test complete user flows through the application

### Mocking: vi.mock

### Coverage

This project has coverage reporting configured. Aim for 80%+ coverage.


*Test file structure*

```typescript
import { describe, it, expect } from 'vitest'

describe('MyFunction', () => {
  it('should return expected result', () => {
    const result = myFunction(input)
    expect(result).toBe(expected)
  })
})
```

## Error Handling

### Error Handling Style: Try-Catch Blocks

This project uses **custom error classes** for specific error types.


*Standard error handling pattern*

```typescript
try {
  const result = await riskyOperation()
  return result
} catch (error) {
  console.error('Operation failed:', error)
  throw new Error('User-friendly message')
}
```

## Common Workflows

These workflows were detected from analyzing commit patterns.

### Feature Development

Standard feature implementation workflow

**Frequency**: ~7 times per month

**Steps**:
1. Add feature implementation
2. Add tests for feature
3. Update documentation

**Files typically involved**:
- `e2e/*`
- `src/core/agents/*`
- `src/*`
- `**/*.test.*`

**Example commit sequence**:
```
fix(agents): surface Claude CLI exit errors (#190)
fix(agents): recover wrapped Pi JSON output (#195)
docs: add captain-approved VISION.md (#197)
```

### Refactoring

Code refactoring and cleanup workflow

**Frequency**: ~4 times per month

**Steps**:
1. Ensure tests pass before refactor
2. Refactor code structure
3. Verify tests still pass

**Files typically involved**:
- `src/**/*`

**Example commit sequence**:
```
fix(agents): recover wrapped Pi JSON output (#195)
docs: add captain-approved VISION.md (#197)
feat(agents): add native Cursor CLI support (#203)
```


## Best Practices

Based on analysis of the codebase, follow these practices:

### Do

- Use conventional commit format (feat:, fix:, etc.)
- Write tests using vitest
- Follow *.test.ts naming pattern
- Use camelCase for file names
- Prefer named exports

### Don't

- Don't write vague commit messages
- Don't skip tests for new features
- Don't deviate from established patterns without discussion

---

*This skill was auto-generated by [ECC Tools](https://ecc.tools). Review and customize as needed for your team.*
