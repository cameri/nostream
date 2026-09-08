import { expect } from 'chai'

import { Settings } from '../../../src/@types/settings'
import {
  getEffectiveProbeIntervalSeconds,
  getProbeIntervalMs,
  MIN_PROBE_INTERVAL_SECONDS,
} from '../../../src/utils/nip66-schedule'

describe('nip66-schedule', () => {
  const settings = (probeIntervalSeconds?: number): Settings =>
    ({
      nip66: probeIntervalSeconds === undefined ? undefined : { enabled: true, probeIntervalSeconds, targets: [] },
    }) as Settings

  it('clamps probe intervals below the worker minimum', () => {
    expect(getEffectiveProbeIntervalSeconds(settings(10))).to.equal(MIN_PROBE_INTERVAL_SECONDS)
    expect(getProbeIntervalMs(settings(10))).to.equal(MIN_PROBE_INTERVAL_SECONDS * 1000)
  })

  it('uses configured probe intervals at or above the minimum', () => {
    expect(getEffectiveProbeIntervalSeconds(settings(120))).to.equal(120)
    expect(getProbeIntervalMs(settings(120))).to.equal(120_000)
  })
})
