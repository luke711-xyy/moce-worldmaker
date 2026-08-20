import { describe, expect, it } from 'vitest'
import { clampNumericValue, commitNumericDraft, sanitizeNumericDraft } from './numeric-input'

describe('numeric input drafts', () => {
  it('allows deletion and incomplete decimal drafts', () => {
    expect(sanitizeNumericDraft('')).toBe('')
    expect(sanitizeNumericDraft('-')).toBe('-')
    expect(sanitizeNumericDraft('.')).toBe('.')
    expect(sanitizeNumericDraft('-.')).toBe('-.')
    expect(sanitizeNumericDraft('12.')).toBe('12.')
  })

  it('rejects non-numeric characters without producing a value', () => {
    expect(sanitizeNumericDraft('12a')).toBe('')
    expect(sanitizeNumericDraft('1.2.3')).toBe('')
    expect(sanitizeNumericDraft('1e3')).toBe('')
    expect(sanitizeNumericDraft('+2')).toBe('')
  })

  it('clamps only when the draft is committed', () => {
    expect(commitNumericDraft('10000', 20, { min: 1, max: 1000, integer: true })).toBe(1000)
    expect(commitNumericDraft('0.05', 1, { min: 0.1, max: 100, integer: false })).toBe(0.1)
    expect(commitNumericDraft('3.6', 1, { min: 1, max: 10, integer: true })).toBe(4)
    expect(commitNumericDraft('', 20, { min: 1, max: 1000, integer: true })).toBe(20)
  })

  it('keeps fallback values valid when clamping', () => {
    expect(clampNumericValue(Number.NaN, 0, { min: 1, max: 10 })).toBe(0)
    expect(clampNumericValue(-4, 1, { min: 1, max: 10 })).toBe(1)
  })
})

