/** Shared runtime facts; each ACP adapter owns its wire representation. */
import type { ContentBlock, McpServer, SessionConfigOption } from '@agentclientprotocol/sdk'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { AssistantChunk, AssistantDelivery } from './stream.js'

export type PromptContent = ContentBlock
export type McpConfiguration = McpServer
export type ConfigOption = SessionConfigOption
export type StopReason = 'end_turn' | 'cancelled' | 'max_tokens' | 'max_turn_requests' | 'refusal'
export type Outcome = { reason: StopReason } | { reason: 'error'; error: Error }
export type Activity =
  { state: 'idle'; outcome?: Outcome } | { state: 'running' } | { state: 'requires_action' }
export type RuntimeUpdate =
  | {
      type: 'event'
      event: SessionEvent
      replay: boolean
      assistant?: AssistantDelivery | undefined
    }
  | AssistantChunk
  | { type: 'state'; activity: Activity }
  | { type: 'title'; title: string | null }
  | { type: 'plan'; todos: readonly TodoItem[] | null }
  | { type: 'config'; options: ConfigOption[] }

export interface RuntimeOutput {
  send(session: Session, update: RuntimeUpdate): Promise<void>
  permission(
    session: Session,
    callId: string,
    title: string,
    signal: AbortSignal,
  ): Promise<'allowed-once' | 'rejected' | 'cancelled'>
  /** A failed wire write invalidates this connection. */
  fail(error: unknown): void
}
