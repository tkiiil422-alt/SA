/**
 * M1 assessor: no model call.
 *
 * An explicit candidate (a person addressed the agent directly) is accepted at once; every other candidate is ignored.
 * The interface is the stateless `Assessor` port, so a model-backed assessor can replace this class later.
 */
import type { Assessor, Candidate, EngineForMainSession, Outcome } from '../core/index.ts'
import { plainTitle } from '../infra/text.ts'

/** The fixed acknowledgement an accepted CLI request gets. */
export const ACKNOWLEDGEMENT = '收到，开始处理。'
/** Title length, in characters (not UTF-16 code units). */
const TITLE_CHARS = 60

const titleOf = (text: string): string => plainTitle(text, TITLE_CHARS)

export interface DirectAssessorOptions {
  /** Getter, because the Engine and the Assessor are built in the same composition root. */
  engine: () => Pick<EngineForMainSession, 'decide'>
  /** Receives a failure to record a decision, such as a Policy version change; the Eval then expires on its own. */
  onError?: (error: unknown) => void
}

export class DirectAssessor implements Assessor {
  constructor(private readonly options: DirectAssessorOptions) {}

  request(candidate: Candidate): void {
    const primaryId = candidate.thread.evaluating?.primary ?? candidate.triggers[0]?.id
    if (!primaryId) return
    const primary = candidate.triggers.find(trigger => trigger.id === primaryId) ?? candidate.triggers[0]
    if (!primary) return
    const outcome: Outcome = candidate.strength === 'explicit'
      ? {
        kind: 'accept',
        title: titleOf(primary.text),
        scope: primary.text,
        reason: { code: 'operatorRequest' },
        acknowledgement: ACKNOWLEDGEMENT,
        evalId: candidate.evalId,
      }
      : { kind: 'ignore', reason: { code: 'explicitOnly' }, evalId: candidate.evalId }
    try {
      this.options.engine().decide(primaryId, outcome)
    } catch (error) {
      this.options.onError?.(error)
    }
  }

  /** No per-eval state is kept. */
  release(): void {}
}
