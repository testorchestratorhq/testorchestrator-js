import { test, expect } from '@playwright/test'

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

test.describe('cart', () => {
  test('adds item to cart', { tag: '@smoke' }, () => {
    expect([1, 2, 3]).toContain(2)
  })

  test(
    'removes item from cart',
    { annotation: { type: 'testorchestrator', description: process.env.CASE_REF ?? 'C-10' } },
    () => {
      expect([1, 2].filter((n) => n !== 2)).toEqual([1])
    },
  )

  test('empty cart message', () => {
    console.log('cart is empty')
    expect('Your cart is empty').toMatch(/empty/)
  })

  test('slow inventory lookup', async () => {
    test.setTimeout(300)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  })

  test('saves receipt', async ({}, testInfo) => {
    await testInfo.attach('receipt', { body: 'Total: 42.00 EUR', contentType: 'text/plain' })
    await testInfo.attach('screenshot', { body: PNG, contentType: 'image/png' })
    expect(42).toBeGreaterThan(0)
  })
})
