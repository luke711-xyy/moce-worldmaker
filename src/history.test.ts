import { describe, expect, it } from 'vitest'
import { recordHistoryTransition, redoHistoryTransition, undoHistoryTransition } from './history'

const equal = (left: string, right: string) => left === right

describe('history transitions', () => {
  it('undoes and redoes a linear sequence in order', () => {
    const history = { past: [] as string[], future: [] as string[] }
    expect(recordHistoryTransition(history, 'A', 'B', equal, 10)).toBe(true)
    expect(recordHistoryTransition(history, 'B', 'C', equal, 10)).toBe(true)

    expect(undoHistoryTransition(history, 'C', 10)).toBe('B')
    expect(undoHistoryTransition(history, 'B', 10)).toBe('A')
    expect(redoHistoryTransition(history, 'A', 10)).toBe('B')
    expect(redoHistoryTransition(history, 'B', 10)).toBe('C')
  })

  it('does not create a history entry or clear redo for a no-op', () => {
    const history = { past: ['A'], future: ['C'] }
    expect(recordHistoryTransition(history, 'B', 'B', equal, 10)).toBe(false)
    expect(history).toEqual({ past: ['A'], future: ['C'] })
  })

  it('starts a new branch after undo and drops only the abandoned future', () => {
    const history = { past: [] as string[], future: [] as string[] }
    recordHistoryTransition(history, 'A', 'B', equal, 10)
    recordHistoryTransition(history, 'B', 'C', equal, 10)
    expect(undoHistoryTransition(history, 'C', 10)).toBe('B')

    expect(recordHistoryTransition(history, 'B', 'D', equal, 10)).toBe(true)
    expect(redoHistoryTransition(history, 'D', 10)).toBeNull()
    expect(undoHistoryTransition(history, 'D', 10)).toBe('B')
  })

  it('bounds both stacks without changing transition order', () => {
    const history = { past: [] as string[], future: [] as string[] }
    for (const [before, after] of [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E']]) {
      recordHistoryTransition(history, before, after, equal, 2)
    }
    expect(history.past).toEqual(['C', 'D'])
    expect(undoHistoryTransition(history, 'E', 2)).toBe('D')
    expect(undoHistoryTransition(history, 'D', 2)).toBe('C')
    expect(undoHistoryTransition(history, 'C', 2)).toBeNull()
  })
})
