export type HistoryStacks<T> = {
  past: T[]
  future: T[]
}

/**
 * Record one committed transition. The caller supplies the state before the
 * transition; the state after it is only used to reject no-op transactions.
 * Keeping this small and pure makes the undo/redo invariants testable without
 * mounting the editor.
 */
export function recordHistoryTransition<T>(
  history: HistoryStacks<T>,
  before: T,
  after: T,
  equals: (left: T, right: T) => boolean,
  limit: number,
): boolean {
  if (equals(before, after)) return false
  history.past.push(before)
  history.future = []
  const boundedLimit = Math.max(1, Math.floor(limit))
  if (history.past.length > boundedLimit) history.past.splice(0, history.past.length - boundedLimit)
  return true
}

export function undoHistoryTransition<T>(history: HistoryStacks<T>, current: T, limit: number): T | null {
  const previous = history.past.pop()
  if (previous === undefined) return null
  history.future.push(current)
  const boundedLimit = Math.max(1, Math.floor(limit))
  if (history.future.length > boundedLimit) history.future.splice(0, history.future.length - boundedLimit)
  return previous
}

export function redoHistoryTransition<T>(history: HistoryStacks<T>, current: T, limit: number): T | null {
  const next = history.future.pop()
  if (next === undefined) return null
  history.past.push(current)
  const boundedLimit = Math.max(1, Math.floor(limit))
  if (history.past.length > boundedLimit) history.past.splice(0, history.past.length - boundedLimit)
  return next
}
