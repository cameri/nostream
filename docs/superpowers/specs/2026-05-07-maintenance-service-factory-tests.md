# Test Suite: maintenance-service-factory

**Date:** 2026-05-07  
**Status:** Design approved  
**Coverage Target:** 100% (currently 0%)

## Overview

Add unit tests for `src/factories/maintenance-service-factory.ts` to verify that the factory correctly instantiates and wires together a `MaintenanceService` with its dependencies (EventRepository and settings function).

## Current State

- **File:** `src/factories/maintenance-service-factory.ts`
- **Lines of code:** 8
- **Coverage:** 0%
- **Dependencies:**
  - `getMasterDbClient()` — returns master database client
  - `getReadReplicaDbClient()` — returns read replica database client
  - `EventRepository` — repository class for event data access
  - `createSettings()` — factory function that returns settings
  - `MaintenanceService` — service being instantiated

## Factory Behavior

The factory exports `createMaintenanceService()` which:

1. Gets master and read replica database clients
2. Creates an `EventRepository` with both clients
3. Creates and returns a `MaintenanceService` with the repository and settings function

## Test Approach

### Happy Path Test

Test successful factory execution with mocked dependencies:

- **Setup:**
  - Stub `getMasterDbClient()` and `getReadReplicaDbClient()` to return test doubles
  - Stub `createSettings()` to return a test settings object
  - Spy on `EventRepository` constructor to track calls
  - Spy on `MaintenanceService` constructor to track calls

- **Execution:**
  - Call `createMaintenanceService()`

- **Verification:**
  - Result is a `MaintenanceService` instance
  - `EventRepository` was called with (masterClient, replicaClient)
  - `MaintenanceService` was called with (repository, createSettings function)

### Coverage-Driven Follow-Up

After writing the happy path test and running coverage:
- Identify uncovered lines/branches
- Add tests for error cases (dependency initialization failures)
- Add tests for dependency edge cases if needed

## Test File Structure

**Location:** `test/unit/factories/maintenance-service-factory.spec.ts`

**Pattern:** Follow existing factory test conventions from `settings-factory.spec.ts` and `app-factory.spec.ts`

**Dependencies:**
- `chai` — assertions
- `sinon` — stubs and spies
- `sinonChai` — chai-sinon integration

## Success Criteria

1. Happy path test passes
2. Test file follows project conventions
3. Coverage output shows all lines covered
4. After coverage analysis, add edge case tests if needed to reach >90% statement coverage

## Notes

- The factory is extremely simple (8 lines), so test complexity is minimal
- Focus is on verifying dependency wiring, not service behavior (that's tested in `maintenance-service.spec.ts`)
- Use coverage report to guide what additional tests are needed beyond the happy path
