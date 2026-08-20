export type NumericInputOptions = {
  min?: number
  max?: number
  integer?: boolean
}

// This accepts incomplete drafts such as "-", "." and "-." so the user can
// delete and retype a value without the browser inserting a minimum value.
// The draft is intentionally stricter than Number(): exponent notation,
// letters, plus signs and a second decimal point are not accepted.
const NUMERIC_DRAFT_PATTERN = /^-?(?:\d*(?:\.\d*)?)?$/

export function sanitizeNumericDraft(value: string): string {
  return NUMERIC_DRAFT_PATTERN.test(value) ? value : ''
}

export function clampNumericValue(value: number, fallback: number, options: NumericInputOptions = {}): number {
  if (!Number.isFinite(value)) return fallback
  const rounded = options.integer ? Math.round(value) : value
  return Math.max(options.min ?? -Infinity, Math.min(options.max ?? Infinity, rounded))
}

export function commitNumericDraft(draft: string, fallback: number, options: NumericInputOptions = {}): number {
  const numeric = Number(draft)
  return draft === '' || draft === '-' || draft === '.' || draft === '-.'
    ? clampNumericValue(fallback, fallback, options)
    : clampNumericValue(numeric, fallback, options)
}

