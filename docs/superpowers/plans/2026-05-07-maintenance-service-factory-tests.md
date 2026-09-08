# maintenance-service-factory Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add unit tests for `src/factories/maintenance-service-factory.ts` with 0% → 100% coverage, verifying correct dependency wiring.

**Architecture:** Create a single test file that mocks database clients and the settings factory, then verifies the factory correctly instantiates EventRepository and MaintenanceService with the mocked dependencies.

**Tech Stack:** Mocha, Chai, Sinon, TypeScript

---

## File Structure

**Create:**
- `test/unit/factories/maintenance-service-factory.spec.ts` — Happy-path test with mocked dependencies

**No modifications to source files.**

---

## Task 1: Write Happy-Path Test

**Files:**
- Create: `test/unit/factories/maintenance-service-factory.spec.ts`
- Reference: `src/factories/maintenance-service-factory.ts`

- [ ] **Step 1: Create test file with mocked dependencies**

Create `/workspace/projects/nostream/test/unit/factories/maintenance-service-factory.spec.ts`:

```typescript
import { expect } from 'chai'
import Sinon from 'sinon'

import { createMaintenanceService } from '../../../src/factories/maintenance-service-factory'
import * as databaseClient from '../../../src/database/client'
import * as settingsFactory from '../../../src/factories/settings-factory'
import { MaintenanceService } from '../../../src/services/maintenance-service'
import { EventRepository } from '../../../src/repositories/event-repository'

describe('createMaintenanceService', () => {
  let sandbox: Sinon.SinonSandbox
  let getMasterDbClientStub: Sinon.SinonStub
  let getReadReplicaDbClientStub: Sinon.SinonStub
  let createSettingsStub: Sinon.SinonStub
  let eventRepositorySpy: Sinon.SinonSpy

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    // Mock database clients
    const masterDbClient = { query: sandbox.stub() }
    const replicaDbClient = { query: sandbox.stub() }

    getMasterDbClientStub = sandbox.stub(databaseClient, 'getMasterDbClient').returns(masterDbClient)
    getReadReplicaDbClientStub = sandbox.stub(databaseClient, 'getReadReplicaDbClient').returns(replicaDbClient)

    // Mock settings factory
    const mockSettings = { test: true }
    createSettingsStub = sandbox.stub(settingsFactory, 'createSettings').returns(mockSettings)

    // Spy on EventRepository constructor
    eventRepositorySpy = sandbox.spy(EventRepository.prototype, 'constructor')
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('returns a MaintenanceService instance with correctly wired dependencies', () => {
    const service = createMaintenanceService()

    expect(service).to.be.an.instanceOf(MaintenanceService)
    expect(getMasterDbClientStub).to.have.been.calledOnce
    expect(getReadReplicaDbClientStub).to.have.been.calledOnce
  })
})
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm run test:unit -- test/unit/factories/maintenance-service-factory.spec.ts`

Expected output: Test passes, 1 passing

```
createMaintenanceService
  ✔ returns a MaintenanceService instance with correctly wired dependencies

1 passing
```

- [ ] **Step 3: Commit the test file**

```bash
jj describe -m "test: add maintenance-service-factory happy-path test"
```

---

## Task 2: Run Coverage and Analyze

**Files:**
- Reference: `test/unit/factories/maintenance-service-factory.spec.ts`
- Reference: `src/factories/maintenance-service-factory.ts`

- [ ] **Step 1: Run unit test coverage**

Run: `pnpm run cover:unit 2>&1 | grep -A 20 "Coverage summary"`

Expected: Coverage report shows lines covered for maintenance-service-factory.ts

- [ ] **Step 2: Parse coverage JSON to check file-specific coverage**

Run: 
```bash
node -e "
const fs = require('fs');
const coverage = JSON.parse(fs.readFileSync('coverage-report/coverage-final.json', 'utf8'));
const factoryFile = Object.entries(coverage).find(([file]) => file.includes('maintenance-service-factory.ts'));
if (factoryFile) {
  const [file, data] = factoryFile;
  const statements = data.s || {};
  const covered = Object.values(statements).filter(v => v > 0).length;
  const total = Object.keys(statements).length;
  console.log('maintenance-service-factory.ts coverage:', \`\${covered}/\${total} statements\`);
}
"
```

Expected: Output shows coverage for the factory file (should be 100% if test covers all lines)

- [ ] **Step 3: Identify coverage gaps (if any)**

If coverage is less than 100%, note which lines/branches are uncovered and decide if additional tests are needed. If all statements are covered, proceed to final commit.

---

## Task 3: Add Edge-Case Tests (if needed based on coverage)

**Condition:** Only perform this task if coverage analysis shows gaps.

**Files:**
- Modify: `test/unit/factories/maintenance-service-factory.spec.ts`

Common gaps to address:
- Error handling if `getMasterDbClient()` throws
- Error handling if `getReadReplicaDbClient()` throws
- Error handling if `createSettings()` throws

If coverage report shows uncovered branches in error paths, add tests like:

```typescript
it('throws when getMasterDbClient fails', () => {
  getMasterDbClientStub.throws(new Error('Database connection failed'))
  
  expect(() => createMaintenanceService()).to.throw('Database connection failed')
})
```

- [ ] **Step 1: Add error-case tests** (only if needed)

Add tests for each uncovered error path identified in coverage report.

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm run test:unit -- test/unit/factories/maintenance-service-factory.spec.ts`

Expected: All tests pass

- [ ] **Step 3: Run coverage again to verify gaps are closed**

Run: 
```bash
pnpm run cover:unit 2>&1 | grep -E "Statements|Branches|Functions|Lines" | head -4
```

Expected: maintenance-service-factory.ts shows 100% coverage

- [ ] **Step 4: Commit additional tests**

```bash
jj describe -m "test: add maintenance-service-factory error-case tests"
```

---

## Task 4: Final Verification

**Files:**
- Reference: `test/unit/factories/maintenance-service-factory.spec.ts`

- [ ] **Step 1: Run full test suite**

Run: `pnpm run test:unit 2>&1 | tail -5`

Expected: All tests pass, including new maintenance-service-factory tests

```
1145+ passing
```

- [ ] **Step 2: Verify no regressions in other tests**

Check that no existing tests broke. The test count should increase by the number of tests added.

- [ ] **Step 3: Final status check**

Run: `jj status`

Expected: Clean working copy (no uncommitted changes)

---

## Success Criteria

✅ Test file created at `test/unit/factories/maintenance-service-factory.spec.ts`
✅ Happy-path test verifies MaintenanceService instance creation
✅ Test verifies database clients are retrieved
✅ Test verifies settings factory is called
✅ All tests pass (1145+ total)
✅ maintenance-service-factory.ts coverage: 0% → 100%
✅ Changes committed with clear messages
