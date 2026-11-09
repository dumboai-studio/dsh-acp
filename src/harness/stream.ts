/** Stable ACP identities and incremental text from public Harness stream frames. */
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export type AssistantEvent = SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'>
export interface AssistantDelivery {
  messageId: string
  streamed: boolean
  text?: boolean
  reasoning?: boolean
}
export interface AssistantChunk {
  type: 'chunk'
  messageId: string
  kind: 'text' | 'reasoning'
  text: string
}

/** Replay counts durable attempts; a live attempt reserves the same identity at its start. */
export class AssistantStream {
  private position = ''
  private attempt = 0
  private active:
    | {
        attemptId: string
        position: string
        messageId: string
        blocks: Map<number, string>
        kinds: Set<AssistantChunk['kind']>
      }
    | undefined

  private next(turn: number, step: number): string {
    const position = `${turn}:${step}`
    if (position !== this.position) {
      this.position = position
      this.attempt = 0
    }
    return `assistant:${position}:${++this.attempt}`
  }

  frame(frame: AssistantStreamFrame): AssistantChunk | undefined {
    if (frame.type === 'start') {
      this.active = {
        attemptId: frame.attemptId,
        position: `${frame.turn}:${frame.step}`,
        messageId: this.next(frame.turn, frame.step),
        blocks: new Map(),
        kinds: new Set(),
      }
      return
    }
    const active = this.active
    if (active?.attemptId !== frame.attemptId) return
    if (frame.type === 'end') {
      this.active = undefined
      return
    }
    const chunk = frame.chunk
    let kind: AssistantChunk['kind']
    let text: string
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      kind = chunk.type === 'text-delta' ? 'text' : 'reasoning'
      text = chunk.text
      active.blocks.set(chunk.index, (active.blocks.get(chunk.index) ?? '') + text)
    } else if (
      chunk.type === 'block-end' &&
      (chunk.block.type === 'text' || chunk.block.type === 'reasoning')
    ) {
      kind = chunk.block.type
      const previous = active.blocks.get(chunk.index) ?? ''
      // V1 is append-only; v2's committed snapshot also handles provider replacements.
      text = chunk.block.text.startsWith(previous) ? chunk.block.text.slice(previous.length) : ''
      active.blocks.set(chunk.index, chunk.block.text)
    } else return
    if (text.length === 0) return
    active.kinds.add(kind)
    return { type: 'chunk', messageId: active.messageId, kind, text }
  }

  event(event: AssistantEvent): AssistantDelivery {
    const { turn, step } = event.data
    const active = this.active
    if (active?.position === `${turn}:${step}`)
      return {
        messageId: active.messageId,
        streamed: true,
        text: active.kinds.has('text'),
        reasoning: active.kinds.has('reasoning'),
      }
    return { messageId: this.next(turn, step), streamed: false }
  }
}
