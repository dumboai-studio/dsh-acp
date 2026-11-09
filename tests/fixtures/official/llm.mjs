/** Deterministic provider; all ACP, Agent, tool and persistence code remains real. */
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { setTimeout as delay } from 'node:timers/promises'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'

async function waitForRelease(signal) {
  const path = join(dirname(process.env.DSH_ACP_TEST_FILE), 'release')
  // macOS file watchers can miss creation immediately after stream delivery.
  for (;;) {
    signal.throwIfAborted()
    try {
      await access(path)
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await delay(10, undefined, { signal })
  }
}

function* callTool(id, name, args) {
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id, name, arguments: argumentsText },
  }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

class FixtureAdapter extends LlmAdapter {
  retried = new Set()
  providerInfo() {
    return { id: 'fixture', name: 'Fixture' }
  }

  async listModels(provider) {
    return ['alpha', 'beta'].map((id) => ({
      provider,
      id,
      name: id,
      inputModalities: ['text'],
    }))
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: 128_000 },
      reasoning: {
        efforts: ['low', 'high'].map((id) => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId('high'),
      },
    }
  }

  async *stream(options) {
    const userIndex = options.messages.findLastIndex(
      (message) => message.role === 'user' && message.source.kind === 'user',
    )
    const turn = options.messages.slice(userIndex)
    const prompt = turn[0].content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    if (prompt === 'fail') throw new Error('fixture provider failure')
    if (prompt.startsWith('stream')) {
      if (prompt === 'stream retry' && !this.retried.has(turn[0].id)) {
        this.retried.add(turn[0].id)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'failed prefix' }
        throw new Error('fixture stream retry')
      }
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'thinking ' }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: 'hello ' }
      if (prompt === 'stream gate' || prompt === 'stream cancel' || prompt === 'stream fail')
        await waitForRelease(options.signal)
      if (prompt === 'stream fail') throw new Error('fixture stream failure')
      yield { type: 'reasoning-delta', index: 0, text: 'done' }
      yield { type: 'text-delta', index: 1, text: 'world' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking done' } }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: 'hello world' } }
      // Providers may deliver a complete block without emitting deltas first.
      yield { type: 'block-start', index: 2, blockType: 'text' }
      yield { type: 'block-end', index: 2, block: { type: 'text', text: '!' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (prompt.startsWith('plan')) {
      const completed = turn.filter((message) => message.role === 'tool').length
      if (completed === 0) {
        yield* callTool(ToolCallId('plan-start'), 'todo_write', {
          todos: [
            { content: 'Read fixture', status: 'in_progress' },
            { content: 'Report result', status: 'pending' },
          ],
        })
        return
      }
      if (completed === 1) {
        yield* callTool(ToolCallId('plan-read'), 'read', {
          file_path: process.env.DSH_ACP_TEST_FILE,
        })
        return
      }
      if (completed === 2) {
        yield* callTool(ToolCallId('plan-finish'), 'todo_write', {
          todos: [
            { content: 'Read fixture', status: 'completed' },
            { content: 'Report result', status: 'completed' },
          ],
        })
        return
      }
      const readResult = turn.find(
        (message) => message.role === 'tool' && message.toolCallId === 'plan-read',
      )
      const text = `planned: ${JSON.stringify(readResult.content)}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const tool = turn.find((message) => message.role === 'tool')
    if (!tool && prompt.startsWith('write ')) {
      yield* callTool(ToolCallId('fixture-write'), 'write', {
        file_path: process.env.DSH_ACP_TEST_FILE,
        content: prompt.slice('write '.length),
      })
      return
    }
    if (!tool) {
      const id = ToolCallId(`fixture-${prompt}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id,
        name: 'mcp__fixture__add',
        argumentsDelta: '{"a":2,"b":3}',
      }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id,
          name: 'mcp__fixture__add',
          arguments: '{"a":2,"b":3}',
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (prompt === 'gate') await waitForRelease(options.signal)
    if (prompt === 'cancel') {
      await new Promise((_resolve, reject) => {
        if (options.signal.aborted) return reject(new Error('cancelled'))
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        })
      })
      return
    }
    const result = tool.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    const userTurns = options.messages.filter(
      (message) => message.role === 'user' && message.source.kind === 'user',
    ).length
    const text = `model=${options.model}; effort=${options.reasoningEffort}; tool=${result}; turns=${userTurns}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'fixture-llm'
export const inject = ['llm']
export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], new FixtureAdapter()))
  ctx.on('agent/request-error', (request, next) => {
    if (request.failure.message === 'fixture stream retry') return { kind: 'retry' }
    return next()
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'mcp__fixture__add') return next()
    return { kind: 'ask', reason: 'fixture approval' }
  })
}
