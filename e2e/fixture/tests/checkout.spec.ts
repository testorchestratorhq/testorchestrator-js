import { test, expect } from '@playwright/test'

// End-to-end fixture: a real Playwright suite with a pass, a failure, a flaky test (fails on the first
// attempt, passes on the retry), a skip, a parametrised title and an expected failure (test.fail()).
// No browser is launched: the tests use no page, so the two projects run without browser binaries.

test.describe('checkout', () => {
  test('applies coupon', () => {
    expect(10 - 2).toBe(8)
  })

  test('rejects expired coupon', () => {
    expect({ code: 'OLD', valid: true }).toEqual({ code: 'OLD', valid: false })
  })

  test('retries a declined card', ({}, testInfo) => {
    expect(testInfo.retry, 'the first attempt fails on purpose').toBeGreaterThan(0)
  })

  test('shows legacy wallet', () => {
    test.skip(true, 'legacy wallet retired')
  })

  for (const currency of ['EUR', 'USD', 'GBP']) {
    test(`total in ${currency}`, () => {
      expect(currency).toHaveLength(3)
    })
  }

  test('known rounding bug', () => {
    test.fail()
    expect(0.1 + 0.2).toBe(0.3)
  })
})
