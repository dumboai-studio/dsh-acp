/** ACP v1 handlers: prompt completion waits for the Harness driver to retire. */
import {
  agent,
  methods,
  PROTOCOL_VERSION,
  type AgentContext,
  type SessionUpdate,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk'
import type { HarnessRuntime } from '../harness/runtime.js'
import type { RuntimeOutput } from '../harness/types.js'
import { planUpdate, titleUpdate, toolKind } from '../projector.js'
import { VERSION } from '../version.js'
import { untilAborted } from '../harness/abort.js'
import { messageContent, permissionOptions, toolInput, toolResult, usage, wire } from './shared.js'

function output(
  runtime: HarnessRuntime,
  client: AgentContext,
  fail: (error: unknown) => void,
): RuntimeOutput {
  const notify = (sessionId: string, update: SessionUpdate) =>
    untilAborted(
      client.notify(methods.client.session.update, { sessionId, update }),
      runtime.signal,
    )
  return {
    fail,
    async permission(session, callId, _title, signal) {
      const { outcome } = await client.request<RequestPermissionResponse>(
        methods.client.session.requestPermission,
        {
          sessionId: session.id,
          toolCall: { toolCallId: callId },
          options: permissionOptions,
        } satisfies RequestPermissionRequest,
        { cancellationSignal: signal },
      )
      return outcome.outcome === 'cancelled'
        ? 'cancelled'
        : outcome.optionId === 'allow-once'
          ? 'allowed-once'
          : 'rejected'
    },
    async send(session, update) {
      const send = (value: SessionUpdate) => notify(session.id, value)
      if (update.type === 'state') return
      if (update.type === 'title') {
        const value = titleUpdate(update.title)
        if (value !== undefined) await send(value)
        return
      }
      if (update.type === 'plan') {
        await send(planUpdate(update.todos))
        return
      }
      if (update.type === 'config') {
        await send({ sessionUpdate: 'config_option_update', configOptions: update.options })
        return
      }
      const event = update.event
      if (event.type === 'assistant/message') {
        const message = await messageContent(runtime.ctx, event)
        for (const content of message.thoughts)
          await send({
            sessionUpdate: 'agent_thought_chunk',
            messageId: message.messageId,
            content,
          })
        for (const content of message.content)
          await send({
            sessionUpdate: 'agent_message_chunk',
            messageId: message.messageId,
            content,
          })
        const value = usage(runtime.ctx, session, event)
        if (value !== undefined) await send(value)
      } else if (event.type === 'tool/call') {
        await send({
          sessionUpdate: 'tool_call',
          toolCallId: event.data.callId,
          title: event.data.name,
          kind: toolKind(event.data.name),
          status: 'in_progress',
          rawInput: toolInput(event.data.arguments),
        })
      } else if (event.type === 'tool/result') {
        await send({ sessionUpdate: 'tool_call_update', ...(await toolResult(runtime.ctx, event)) })
      }
    },
  }
}

export function v1Agent(runtime: HarnessRuntime, fail: (error: unknown) => void) {
  return agent({ name: 'dsh-acp-v1' })
    .onRequest(methods.agent.initialize, ({ client }) =>
      wire(async () => {
        await runtime.initialize(output(runtime, client, fail))
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'deepseek-harness-acp', version: VERSION },
          agentCapabilities: {
            mcpCapabilities: { http: true },
            promptCapabilities: {
              image: runtime.imageEnabled,
              audio: false,
              embeddedContext: false,
            },
            sessionCapabilities: { close: {}, list: {}, resume: {} },
          },
          authMethods: [],
        }
      }),
    )
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(methods.agent.session.new, ({ params, signal }) =>
      wire(async () => {
        const record = await runtime.create(params, signal)
        return { sessionId: record.session.id, configOptions: await record.configOptions(signal) }
      }),
    )
    .onRequest(methods.agent.session.resume, ({ params, signal }) =>
      wire(async () => {
        const record = await runtime.resume(
          params.sessionId,
          { ...params, mcpServers: params.mcpServers ?? [] },
          signal,
        )
        const configOptions = await record.configOptions(signal)
        await record.synchronize(false)
        return { configOptions }
      }),
    )
    .onRequest(methods.agent.session.list, ({ params, signal }) =>
      wire(() => runtime.list(params, signal, false)),
    )
    .onRequest(methods.agent.session.close, ({ params }) =>
      wire(async () => {
        await runtime.closeSession(params.sessionId)
        return {}
      }),
    )
    .onRequest(methods.agent.session.setConfigOption, ({ params, signal }) =>
      wire(async () => ({
        configOptions: await runtime
          .require(params.sessionId)
          .setConfig(params.configId, params.value, signal),
      })),
    )
    .onRequest(methods.agent.session.prompt, ({ params, signal }) =>
      wire(async () => {
        const outcome = await runtime
          .require(params.sessionId)
          .submit(params.prompt, runtime.imageEnabled, signal, false).done
        if (outcome.reason === 'error') throw outcome.error
        return { stopReason: outcome.reason }
      }),
    )
    .onNotification(methods.agent.session.cancel, ({ params }) => runtime.cancel(params.sessionId))
}
