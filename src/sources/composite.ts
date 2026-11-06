/**
 * The runtime's one SourceScope: each Trigger's scope goes to the Source it names. A source that is not registered
 * listens to nothing, so its messages are never admitted.
 */
import type { ScopeResult, SourceScope } from '../core/ports.ts'

export class CompositeScope implements SourceScope {
  private readonly scopes: Map<string, SourceScope>

  constructor(sources: readonly (SourceScope & { readonly source: string })[]) {
    this.scopes = new Map(sources.map(item => [item.source, item]))
  }

  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult {
    const scope = this.scopes.get(input.source)
    return scope ? scope.scope(input) : { listened: false, reason: 'source_disabled' }
  }
}
