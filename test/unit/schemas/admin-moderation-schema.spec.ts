import { expect } from 'chai'

import { adminModerationLimitsPatchSchema } from '../../../src/schemas/admin-moderation-schema'

describe('admin-moderation-schema', () => {
  it('accepts the same kinds event admission accepts', () => {
    const result = adminModerationLimitsPatchSchema.safeParse({
      kind: {
        blacklist: [65536, [65536, 65536]],
        whitelist: [0, [0, 65535]],
      },
    })

    expect(result.success).to.equal(true)
  })

  it('rejects negative kinds and inverted ranges', () => {
    expect(adminModerationLimitsPatchSchema.safeParse({ kind: { blacklist: [-1] } }).success).to.equal(false)
    expect(adminModerationLimitsPatchSchema.safeParse({ kind: { blacklist: [[10, 1]] } }).success).to.equal(false)
  })
})
