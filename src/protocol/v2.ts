/** Experimental ACP v2 handlers over the shared Harness runtime, without a v1 relay. */
import * as acp from '@agentclientprotocol/sdk/experimental/v2'
import type { HarnessRuntime, SessionSetup } from '../harness/runtime.js'
import type { ConfigOption, PromptContent, RuntimeOutput, StopReason } from '../harness/types.js'
import type { Session } from '@deepseek-ai/dsh-session'
import { toolKind } from '../projector.js'
import { VERSION } from '../version.js'
import { untilAborted } from '../harness/abort.js'
import { messageContent, permissionOptions, toolInput, toolResult, usage, wire } from './shared.js'

function v2Config(options: ConfigOption[]): acp.SessionConfigOption[] {
  return options.map(({ id, ...option }): acp.SessionConfigOption => {
    if (option.type === 'boolean') return { ...option, configId: id }
    return {
      ...option,
      configId: id,
      options: option.options.flatMap((value) => ('group' in value ? value.options : [value])),
    }
  })
}

function content(blocks: readonly acp.ContentBlock[]): PromptContent[] {
  return blocks.map((block) => {
    if (acp.ContentBlock.isText(block)) return { type: 'text', text: block.text }
    if (acp.ContentBlock.isImage(block))
      return { type: 'image', data: block.data, mimeType: block.mimeType }
    if (acp.ContentBlock.isResourceLink(block))
      return { type: 'resource_link', name: block.name, uri: block.uri }
    throw acp.RequestError.invalidParams(undefined, `unsupported prompt content: ${block.type}`)
  })
}

function setup(params: acp.NewSessionRequest | acp.ResumeSessionRequest): SessionSetup {
  return {
    cwd: params.cwd,
    ...(params.additionalDirectories === undefined
      ? {}
      : { additionalDirectories: params.additionalDirectories }),
    mcpServers: (params.mcpServers ?? []).map((server) => {
      if (acp.McpServer.isStdio(server))
        return {
          name: server.name,
          command: server.command,
          args: server.args ?? [],
          env: server.env ?? [],
        }
      if (acp.McpServer.isHttp(server))
        return {
          type: 'http' as const,
          name: server.name,
          url: server.url,
          headers: server.headers ?? [],
        }
      throw acp.RequestError.invalidParams(undefined, `unsupported MCP transport: ${server.type}`)
    }),
  }
}

const idleUpdates: Record<StopReason, acp.SessionUpdate> = {
  end_turn: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
  cancelled: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' },
  max_tokens: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'max_tokens' },
  max_turn_requests: {
    sessionUpdate: 'state_update',
    state: 'idle',
    stopReason: 'max_turn_requests',
  },
  refusal: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'refusal' },
}

function output(
  runtime: HarnessRuntime,
  client: acp.AgentContext,
  fail: (error: unknown) => void,
): RuntimeOutput {
  const toolIds = new WeakMap<Session, Map<string, string>>()
  const calls = (session: Session): Map<string, string> => {
    let ids = toolIds.get(session)
    if (ids === undefined) {
      ids = new Map()
      toolIds.set(session, ids)
    }
    return ids
  }
  const notify = (sessionId: string, update: acp.SessionUpdate) =>
    untilAborted(
      client.notify(acp.methods.client.session.update, { sessionId, update }),
      runtime.signal,
    )
  return {
    fail,
    async permission(session, callId, title, signal) {
      const { outcome } = await client.request(
        acp.methods.client.session.requestPermission,
        {
          sessionId: session.id,
          title,
          subject: {
            type: 'tool_call',
            toolCall: { toolCallId: calls(session).get(callId) ?? callId },
          },
          options: permissionOptions,
        },
        { cancellationSignal: signal },
      )
      if (acp.RequestPermissionOutcome.isSelected(outcome))
        return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
      return 'cancelled'
    },
    async send(session, update) {
      const send = (value: acp.SessionUpdate) => notify(session.id, value)
      if (update.type === 'chunk') {
        const content = { type: 'text' as const, text: update.text }
        await send(
          update.kind === 'text'
            ? { sessionUpdate: 'agent_message_chunk', messageId: update.messageId, content }
            : {
                sessionUpdate: 'agent_thought_chunk',
                messageId: `${update.messageId}:thought`,
                content,
              },
        )
        return
      }
      if (update.type === 'state') {
        const state = update.activity
        if (state.state === 'running') {
          await send({ sessionUpdate: 'state_update', state: 'running' })
          return
        }
        if (state.state === 'requires_action') {
          await send({ sessionUpdate: 'state_update', state: 'requires_action' })
          return
        }
        const outcome = state.outcome
        if (outcome === undefined) await send({ sessionUpdate: 'state_update', state: 'idle' })
        else if (outcome.reason === 'error')
          await send({
            sessionUpdate: 'state_update',
            state: 'idle',
            stopReason: 'error',
            error: { code: -32603, message: outcome.error.message },
          })
        else await send(idleUpdates[outcome.reason])
        return
      }
      if (update.type === 'title') {
        if (update.title !== null)
          await send({ sessionUpdate: 'session_info_update', title: update.title })
        return
      }
      if (update.type === 'plan') {
        await send({
          sessionUpdate: 'plan_update',
          plan: {
            type: 'items',
            planId: 'todos',
            entries: (update.todos ?? []).map((todo) => ({ ...todo, priority: 'medium' })),
          },
        })
        return
      }
      if (update.type === 'config') {
        await send({
          sessionUpdate: 'config_option_update',
          configOptions: v2Config(update.options),
        })
        return
      }
      const event = update.event
      if (
        event.type === 'assistant/message' ||
        event.type === 'assistant/attempt' ||
        (event.type === 'user/message' && event.data.source.kind === 'user')
      ) {
        const message = await messageContent(runtime.ctx, event, update.assistant)
        if (event.type === 'user/message') {
          await send({
            sessionUpdate: 'user_message',
            messageId: message.messageId,
            content: message.content,
          })
          return
        }
        if (message.thoughts.length > 0 || update.assistant?.reasoning)
          await send({
            sessionUpdate: 'agent_thought',
            messageId: `${message.messageId}:thought`,
            content: message.thoughts,
          })
        if (message.content.length > 0 || update.assistant?.text)
          await send({
            sessionUpdate: 'agent_message',
            messageId: message.messageId,
            content: message.content,
          })
        if (!update.replay && event.type === 'assistant/message') {
          const value = usage(runtime.ctx, session, event)
          if (value !== undefined) await send(value)
        }
      } else if (event.type === 'tool/call') {
        // Model providers may reuse call IDs in later turns; log offsets never repeat.
        const toolCallId = `${event.seq}:${event.data.callId}`
        calls(session).set(event.data.callId, toolCallId)
        await send({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          title: event.data.name,
          kind: toolKind(event.data.name),
          status: 'in_progress',
          rawInput: toolInput(event.data.arguments),
        })
      } else if (event.type === 'tool/result') {
        const result = await toolResult(runtime.ctx, event)
        await send({
          sessionUpdate: 'tool_call_update',
          ...result,
          toolCallId: calls(session).get(result.toolCallId) ?? `${event.seq}:${result.toolCallId}`,
        })
      } else if (event.type === 'todo/write' && update.replay) {
        await send({
          sessionUpdate: 'plan_update',
          plan: {
            type: 'items',
            planId: 'todos',
            entries: event.data.todos.map((todo) => ({ ...todo, priority: 'medium' })),
          },
        })
      }
    },
  }
}

export function v2Agent(runtime: HarnessRuntime, fail: (error: unknown) => void) {
  return acp
    .agent({ name: 'dsh-acp-v2' })
    .onRequest(acp.methods.agent.initialize, ({ client }) =>
      wire(async () => {
        await runtime.initialize(output(runtime, client, fail))
        return {
          protocolVersion: acp.PROTOCOL_VERSION,
          info: { name: 'dsh-acp', version: VERSION },
          capabilities: {
            session: {
              prompt: { ...(runtime.imageEnabled ? { image: {} } : {}) },
              mcp: { stdio: {}, http: {} },
            },
          },
          authMethods: [],
        }
      }),
    )
    .onRequest(acp.methods.agent.session.new, ({ params, signal }) =>
      wire(async () => {
        const record = await runtime.create(setup(params), signal)
        return {
          sessionId: record.session.id,
          configOptions: v2Config(await record.configOptions(signal)),
        }
      }),
    )
    .onRequest(acp.methods.agent.session.resume, ({ params, signal }) =>
      wire(async () => {
        if (params.replayFrom != null && !acp.ReplayFrom.isStart(params.replayFrom))
          throw acp.RequestError.invalidParams(undefined, 'unsupported replay cursor')
        const record = await runtime.resume(params.sessionId, setup(params), signal)
        const configOptions = v2Config(await record.configOptions(signal))
        await record.synchronize(true, signal, params.replayFrom != null)
        return { configOptions }
      }),
    )
    .onRequest(acp.methods.agent.session.list, ({ params, signal }) =>
      wire(() => runtime.list(params, signal, true)),
    )
    .onRequest(acp.methods.agent.session.close, ({ params }) =>
      wire(async () => {
        await runtime.closeSession(params.sessionId)
        return {}
      }),
    )
    .onRequest(acp.methods.agent.session.setConfigOption, ({ params, signal }) =>
      wire(async () => {
        if (!acp.SetSessionConfigOptionRequest.isId(params))
          throw acp.RequestError.invalidParams(undefined, 'this option requires an id value')
        return {
          configOptions: v2Config(
            await runtime
              .require(params.sessionId)
              .setConfig(params.configId, params.value, signal),
          ),
        }
      }),
    )
    .onRequest(acp.methods.agent.session.prompt, ({ params, signal }) =>
      wire(async () => ({
        messageId: await runtime
          .require(params.sessionId)
          .submit(content(params.prompt), runtime.imageEnabled, signal, true).accepted,
      })),
    )
    .onNotification(acp.methods.agent.session.cancel, ({ params }) =>
      runtime.cancel(params.sessionId),
    )
}
