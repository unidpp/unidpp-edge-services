// Pure units for the Accept→context negotiation table (discovery
// protocol C4): the table maps each representation media type to its
// routing context, and the parser honours RFC 9110 q-weights, client
// order, case-insensitivity and q=0.

import { describe, expect, it } from 'vitest'
import { contextForAccept } from '../src/negotiate'

describe('accept-header negotiation (the table)', () => {
  it('maps each media type to its routing context', () => {
    expect(contextForAccept('application/untp+json')).toEqual({ role: 'machine' })
    expect(contextForAccept('application/en18222+json')).toEqual({ role: 'customs' })
    expect(contextForAccept('text/html')).toEqual({ role: 'consumer' })
    expect(contextForAccept(null)).toBeNull()
  })

  it('picks the most preferred offered representation (q-weights, client order)', () => {
    // An unoffered type first: the best offered one still wins.
    expect(contextForAccept('application/xml, application/untp+json')).toEqual({ role: 'machine' })
    // q-weights reorder the client's preference.
    expect(contextForAccept('text/html;q=0.5, application/untp+json;q=0.9')).toEqual({ role: 'machine' })
    expect(contextForAccept('application/untp+json;q=0.5, text/html;q=0.9')).toEqual({ role: 'consumer' })
    // Equal weights: client order breaks the tie.
    expect(contextForAccept('text/html, application/untp+json')).toEqual({ role: 'consumer' })
    expect(contextForAccept('application/untp+json, text/html')).toEqual({ role: 'machine' })
    // Case-insensitive; parameters other than q are ignored.
    expect(contextForAccept('APPLICATION/EN18222+JSON; charset=utf-8')).toEqual({ role: 'customs' })
    // A browser's real-world Accept list routes to the consumer
    // destination.
    expect(contextForAccept('text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8')).toEqual({ role: 'consumer' })
  })

  it('negotiates nothing for unknown, wildcard or unacceptable media types', () => {
    expect(contextForAccept('application/json')).toBeNull()
    expect(contextForAccept('*/*')).toBeNull()
    expect(contextForAccept('')).toBeNull()
    // q=0 means "not acceptable": the type is dropped entirely.
    expect(contextForAccept('application/untp+json;q=0, text/html')).toEqual({ role: 'consumer' })
    expect(contextForAccept('application/untp+json;q=0')).toBeNull()
    // Malformed q values fall back to weight 1.
    expect(contextForAccept('application/untp+json;q=nonsense')).toEqual({ role: 'machine' })
  })
})
