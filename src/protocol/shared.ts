/** Render committed Harness content without imposing either ACP lifecycle. */
import type { Context } from '@deepseek-ai/cordis'
import { RequestError, type ContentBlock } from '@agentclientprotocol/sdk'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { assembleAssistantStream } from '@deepseek-ai/dsh-llm'
import { assistantBlockToAcp, AcpContentError } from '../harness/content.js'
import { AcpMcpConfigError } from '../harness/mcp.js'
import { AcpModelConfigError } from '../harness/model.js'
import type {} from '@deepseek-ai/dsh-token-meter'

export const permissionOptions = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' as const },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' as const },
]

export async function messageContent(
  ctx: Context,
  event:
    | SessionEvent<'assistant/message'>
    | SessionEvent<'assistant/attempt'>
    | SessionEvent<'user/message'>,
  delivery?: { messageId: string; streamed: boolean },
  appendOnly = false,
) {
  const blocks =
    event.type === 'assistant/attempt'
      ? assembleAssistantStream(event.data.stream).interruptedBlocks()
      : event.type === 'user/message'
        ? event.data.content
        : event.data.message.content
  const messageId =
    delivery?.messageId ??
    (event.type === 'user/message'
      ? event.data.id
      : event.type === 'assistant/message'
        ? event.data.message.id
        : `attempt:${event.seq}`)
  const content: ContentBlock[] = []
  const thoughts: ContentBlock[] = []
  for (const block of blocks) {
    if (appendOnly && delivery?.streamed && (block.type === 'text' || block.type === 'reasoning'))
      continue
    if (block.type === 'reasoning') {
      if (block.text.length > 0) thoughts.push({ type: 'text', text: block.text })
    } else {
      const converted = await assistantBlockToAcp(ctx, block)
      if (converted !== undefined) content.push(converted)
    }
  }
  return { messageId, content, thoughts }
}

export async function toolResult(ctx: Context, event: SessionEvent<'tool/result'>) {
  const content = []
  for (const block of event.data.message.content) {
    const converted = await assistantBlockToAcp(ctx, block)
    if (converted !== undefined) content.push({ type: 'content' as const, content: converted })
  }
  return {
    toolCallId: event.data.message.toolCallId,
    status: event.data.message.isError === true ? ('failed' as const) : ('completed' as const),
    content,
  }
}

export function toolInput(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch (_malformedModelArguments) {
    return value
  }
}

export function usage(ctx: Context, session: Session, event: SessionEvent<'assistant/message'>) {
  const size = session.requestContext()?.contextWindow
  const meter = ctx.get('tokenMeter')
  return event.data.usage === undefined || size === undefined || meter === undefined
    ? undefined
    : { sessionUpdate: 'usage_update' as const, used: meter.measure(session).totalTokens, size }
}

/** Keep actionable failure detail; the SDK deliberately hides ordinary exceptions. */
export async function wire<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof RequestError) throw error
    if (
      error instanceof AcpMcpConfigError ||
      error instanceof AcpModelConfigError ||
      (error instanceof AcpContentError && error.kind === 'invalid')
    ) {
      throw RequestError.invalidParams(undefined, error.message)
    }
    throw RequestError.internalError(
      undefined,
      error instanceof Error ? error.message : String(error),
    )
  }
}
