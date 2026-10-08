# @paperclipai/db

## Unreleased

### Minor Changes

- Add migration `0298_high_vulture.sql` with permanent MCP company-retirement receipts, immutable launch identities and enrollment tombstones, exact launch-deletion receipts, retired company UUID reuse protection, and TRUNCATE guards. Preserve migration `0297` and refresh the generated snapshot under the existing pruning policy.

### Patch Changes

- Retain embedded PostgreSQL fixture data when shutdown fails or exceeds its settlement deadline; reclaim files only after successful process exit.

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1
- Updated dependencies
  - @paperclipai/shared@0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

### Patch Changes

- Updated dependencies [6077ae6]
- Updated dependencies
  - @paperclipai/shared@0.3.0

## 0.2.7

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.7

## 0.2.6

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.6

## 0.2.5

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.5

## 0.2.4

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.4

## 0.2.3

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.3

## 0.2.2

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.2

## 0.2.1

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.1
