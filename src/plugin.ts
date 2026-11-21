/** Direct Harness ACP endpoint with SDK version negotiation. */
import type { Context } from '@deepseek-ai/cordis'
import {
  agentProtocolRouter,
  ndJsonStream,
  type AnyMessage,
} from '@agentclientprotocol/sdk/experimental/v2'
import { Readable, Writable } from 'node:stream'
import { type DshAcpConfig } from './config.js'
import { HarnessRuntime } from './harness/runtime.js'
import { v1Agent } from './protocol/v1.js'
import { v2Agent } from './protocol/v2.js'

export { Config, type DshAcpConfig } from './config.js'
export const name = 'dsh-acp'
export const inject = [
  'agents',
  'llm',
  'sessionPersistence',
  'sessions',
  'sessionProjections',
  'sessionProjectionCache',
]

/** Mount one version-negotiated connection; disposal drains all owned agents. */
export function apply(ctx: Context, config: DshAcpConfig): void {
  const runtime = new HarnessRuntime(ctx, config)
  const logger = ctx.logger
  const transport =
    config.stream ??
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    )
  const abort = new AbortController()
  const fail = (error: unknown): void => {
    if (abort.signal.aborted) return
    logger.warn(`dsh-acp: transport failed: ${String(error)}`)
    abort.abort(error)
  }
  const connection = agentProtocolRouter()
    .withV1(v1Agent(runtime, fail))
    .withV2(v2Agent(runtime, fail))
    .connect({
      ...transport,
      readable: transport.readable.pipeThrough(new TransformStream<AnyMessage, AnyMessage>(), {
        signal: abort.signal,
      }),
    })
  void connection.closed
    .then(() => {
      abort.abort()
      return runtime.close()
    })
    .catch((error: unknown) => logger.warn(`dsh-acp: teardown failed: ${String(error)}`))
  ctx.effect(
    () => async () => {
      abort.abort()
      await runtime.close()
    },
    'dsh-acp.connection',
  )
}
