/** Exercise experimental v2 against the packaged CLI and real Harness services. */
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import * as acp from '@agentclientprotocol/sdk/experimental/v2'
import { describe, expect, it } from 'vitest'

const bin =
  process.env.DSH_ACP_TEST_BIN ?? fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const patch = fileURLToPath(new URL('./fixtures/official/acp.patch.yml', import.meta.url))
const autonomousPatch = fileURLToPath(
  new URL('./fixtures/official/autonomous.patch.yml', import.meta.url),
)
const mcp = fileURLToPath(new URL('./fixtures/official/mcp.mjs', import.meta.url))
const mcpServers: acp.McpServer[] = [
  { type: 'stdio', name: 'fixture', command: process.execPath, args: [mcp] },
]

function launch(cwd: string, permissions: 'allow' | 'hold' = 'allow', patches: string[] = []) {
  const args = [bin, '--patch', patch, ...patches.flatMap((path) => ['--patch', path])]
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
      DSH_HOME: join(cwd, '.dsh'),
      DSH_ACP_TEST_SESSIONS: join(cwd, '.sessions'),
      DSH_ACP_TEST_FILE: join(cwd, 'fixture.txt'),
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'read-only',
    },
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  let diagnostics = ''
  let raw = ''
  child.stdout.on('data', (chunk: Buffer) => {
    raw += chunk.toString('utf8')
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    diagnostics += chunk
  })
  const notifications: acp.UpdateSessionNotification[] = []
  const requests: acp.RequestPermissionRequest[] = []
  const permissionGate = Promise.withResolvers<undefined>()
  const listeners = new Set<() => void>()
  const connection = acp
    .client({ name: 'v2-test' })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      notifications.push(params)
      for (const listener of listeners) listener()
    })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
      requests.push(params)
      for (const listener of listeners) listener()
      // An unanswered permission intentionally ignores cancellation by the agent.
      if (permissions === 'hold') await permissionGate.promise
      return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    })
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    )
  function waitFor(predicate: () => boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (!predicate()) return
        clearTimeout(timer)
        listeners.delete(check)
        resolve()
      }
      const timer = setTimeout(() => {
        listeners.delete(check)
        reject(new Error(`v2 event timeout: ${diagnostics}\n${JSON.stringify(notifications)}`))
      }, 8_000)
      listeners.add(check)
      check()
    })
  }
  return {
    agent: connection.agent,
    notifications,
    requests,
    allowPermissions: () => permissionGate.resolve(undefined),
    assertStateBeforeResponse() {
      const frames: {
        method?: string
        result?: unknown
        params?: { update?: acp.SessionUpdate }
      }[] = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as (typeof frames)[number])
      const response = frames.findLastIndex((frame) => frame.result !== undefined)
      const state = frames.findLastIndex(
        (frame) => frame.params?.update?.sessionUpdate === 'state_update',
      )
      expect(state).toBeGreaterThanOrEqual(0)
      expect(state).toBeLessThan(response)
      return frames[state]?.params?.update
    },
    async initialize(version = 2) {
      return connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: version,
        info: { name: 'v2-test', version: '1' },
        capabilities: {},
      })
    },
    newSession: () => connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers }),
    prompt: (sessionId: string, text: string, signal?: AbortSignal) =>
      connection.agent.request(
        acp.methods.agent.session.prompt,
        { sessionId, prompt: [{ type: 'text', text }] },
        signal === undefined ? {} : { cancellationSignal: signal },
      ),
    async startAutonomous(sessionId: string) {
      await writeFile(join(cwd, 'autonomous.tmp'), JSON.stringify({ sessionId, text: 'gate' }))
      await rename(join(cwd, 'autonomous.tmp'), join(cwd, 'autonomous.json'))
      await waitFor(() =>
        permissions === 'hold'
          ? requests.length > 0
          : notifications.some(
              (n) =>
                acp.SessionUpdate.isToolCallUpdate(n.update) && n.update.status === 'completed',
            ),
      )
    },
    waitFor,
    idle(sessionId: string, start = 0) {
      return waitFor(() =>
        notifications
          .slice(start)
          .some(
            (n) =>
              n.sessionId === sessionId &&
              acp.SessionUpdate.isStateUpdate(n.update) &&
              acp.StateUpdate.isIdle(n.update),
          ),
      )
    },
    async finish() {
      connection.close()
      child.stdin.end()
      expect(await exited, diagnostics).toBe(0)
      expect(diagnostics).toBe('')
    },
    async stop() {
      connection.close()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    },
  }
}

function reply(updates: acp.UpdateSessionNotification[]): string {
  return updates
    .flatMap(({ update }) =>
      acp.SessionUpdate.isAgentMessage(update)
        ? (update.content ?? []).flatMap((block) =>
            acp.ContentBlock.isText(block) ? [block.text] : [],
          )
        : [],
    )
    .join('')
}

describe('direct Harness ACP v2', () => {
  it('negotiates v2, selects models, reports plans/tools/titles and replays stable message IDs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-'))
    await writeFile(join(cwd, 'fixture.txt'), 'fixture content')
    let server = launch(cwd)
    try {
      const initialized = await server.initialize(99)
      expect(initialized).toMatchObject({
        protocolVersion: 2,
        capabilities: { session: { mcp: { stdio: {}, http: {} } } },
      })
      const session = await server.newSession()
      const option = session.configOptions?.find((value) => value.configId === 'model')
      expect(option).toMatchObject({ type: 'select' })
      await server.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: 'model',
        type: 'id',
        value: '["fixture","beta"]',
      })
      await server.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: 'reasoning_effort',
        type: 'id',
        value: 'low',
      })
      const accepted = await server.prompt(session.sessionId, 'plan this task')
      expect(accepted.messageId).toEqual(expect.any(String))
      await server.idle(session.sessionId)
      expect(server.notifications.map((n) => n.update)).toContainEqual(
        expect.objectContaining({ sessionUpdate: 'user_message', messageId: accepted.messageId }),
      )
      expect(reply(server.notifications)).toContain('fixture content')
      expect(server.notifications.map((n) => n.update)).toContainEqual(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          title: 'read',
          kind: 'read',
        }),
      )
      expect(server.notifications.map((n) => n.update)).toContainEqual({
        sessionUpdate: 'plan_update',
        plan: {
          type: 'items',
          planId: 'todos',
          entries: [
            { content: 'Read fixture', status: 'completed', priority: 'medium' },
            { content: 'Report result', status: 'completed', priority: 'medium' },
          ],
        },
      })
      expect(await server.agent.request(acp.methods.agent.session.list, { cwd })).toMatchObject({
        sessions: [{ sessionId: session.sessionId, title: 'plan this task' }],
      })
      const originalMessages = server.notifications
        .map((n) => n.update)
        .filter(acp.SessionUpdate.isAgentMessage)
      await server.finish()
      server = launch(cwd)
      await server.initialize()
      await server.agent.request(acp.methods.agent.session.resume, {
        sessionId: session.sessionId,
        cwd,
        mcpServers,
      })
      server.assertStateBeforeResponse()
      await server.idle(session.sessionId)
      expect(server.notifications.some((n) => acp.SessionUpdate.isAgentMessage(n.update))).toBe(
        false,
      )
      expect(server.notifications.at(-1)?.update).toMatchObject({
        sessionUpdate: 'state_update',
        state: 'idle',
      })
      server.notifications.length = 0
      await server.agent.request(acp.methods.agent.session.resume, {
        sessionId: session.sessionId,
        cwd,
        mcpServers,
        replayFrom: { type: 'start' },
      })
      await server.idle(session.sessionId)
      expect(server.notifications.map((n) => n.update)).toContainEqual(
        expect.objectContaining({ sessionUpdate: 'user_message', messageId: accepted.messageId }),
      )
      expect(
        server.notifications.map((n) => n.update).filter(acp.SessionUpdate.isAgentMessage),
      ).toEqual(originalMessages)
      expect(
        server.notifications.filter((n) => acp.SessionUpdate.isStateUpdate(n.update)),
      ).toHaveLength(1)
      const start = server.notifications.length
      await server.prompt(session.sessionId, 'continue')
      await server.idle(session.sessionId, start)
      expect(reply(server.notifications.slice(start))).toBe(
        'model=beta; effort=low; tool=5; turns=2',
      )
      expect(server.requests.at(-1)).toMatchObject({
        title: 'fixture approval',
        subject: { type: 'tool_call' },
      })
      await server.finish()
    } finally {
      await server.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps busy prompts pending, ignores cancellation after insertion and cancels queued messages', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-queue-'))
    const server = launch(cwd)
    try {
      await server.initialize()
      const { sessionId } = await server.newSession()
      const acceptedAbort = new AbortController()
      const accepted = await server.prompt(sessionId, 'cancel', acceptedAbort.signal)
      acceptedAbort.abort()
      await server.waitFor(() =>
        server.notifications.some(
          (n) => acp.SessionUpdate.isToolCallUpdate(n.update) && n.update.status === 'completed',
        ),
      )
      const stateCount = server.notifications.filter((n) =>
        acp.SessionUpdate.isStateUpdate(n.update),
      ).length
      await server.agent.request(acp.methods.agent.session.resume, { sessionId, cwd, mcpServers })
      server.assertStateBeforeResponse()
      await server.waitFor(
        () =>
          server.notifications.filter((n) => acp.SessionUpdate.isStateUpdate(n.update)).length >
          stateCount,
      )
      expect(
        server.notifications.filter((n) => acp.SessionUpdate.isStateUpdate(n.update)).at(-1)
          ?.update,
      ).toMatchObject({ state: 'running' })
      const cancelledRequest = new AbortController()
      const removed = server.prompt(sessionId, 'removed-before-insertion', cancelledRequest.signal)
      const removedResult = expect(removed).rejects.toMatchObject({ code: -32800 })
      cancelledRequest.abort()
      await removedResult
      const queued = server.prompt(sessionId, 'queued')
      let answered = false
      void queued.then(
        () => {
          answered = true
        },
        () => undefined,
      )
      const cancelled = expect(queued).rejects.toMatchObject({ code: -32800 })
      // Ordered request/response is a barrier; no timing-based sleep assertion.
      await server.agent.request(acp.methods.agent.session.list, {})
      expect(answered).toBe(false)
      const start = server.notifications.length
      await server.agent.notify(acp.methods.agent.session.cancel, { sessionId })
      await cancelled
      await server.idle(sessionId, start)
      expect(server.notifications.at(-1)?.update).toMatchObject({
        state: 'idle',
        stopReason: 'cancelled',
      })
      expect(
        server.notifications
          .map((n) => n.update)
          .filter(acp.SessionUpdate.isUserMessage)
          .map((m) => m.messageId),
      ).toEqual([accepted.messageId])
      const after = server.notifications.length
      await server.prompt(sessionId, 'next')
      await server.idle(sessionId, after)
      expect(reply(server.notifications.slice(after))).toContain('turns=2')
      await server.finish()
    } finally {
      await server.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it('reports failures after acceptance through state and permits immediate continuation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-failure-'))
    const server = launch(cwd)
    try {
      await server.initialize()
      const { sessionId } = await server.newSession()
      const accepted = await server.prompt(sessionId, 'fail')
      expect(accepted.messageId).toEqual(expect.any(String))
      await server.idle(sessionId)
      expect(server.notifications.at(-1)?.update).toMatchObject({
        sessionUpdate: 'state_update',
        state: 'idle',
        stopReason: 'error',
      })
      expect(JSON.stringify(server.notifications.at(-1))).toContain('fixture provider failure')
      const start = server.notifications.length
      await expect(
        server.agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'image', data: 'invalid', mimeType: 'image/png' }],
        }),
      ).rejects.toMatchObject({ code: -32602 })
      await server.prompt(sessionId, 'recover')
      await server.idle(sessionId, start)
      expect(reply(server.notifications.slice(start))).toContain('turns=2')
      await expect(
        server.agent.request(acp.methods.agent.session.resume, { sessionId: 'missing', cwd }),
      ).rejects.toMatchObject({ code: -32002 })
      await server.finish()
    } finally {
      await server.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it('closes a session while the client leaves its permission request unanswered', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-permission-'))
    const server = launch(cwd, 'hold')
    try {
      await server.initialize()
      const { sessionId } = await server.newSession()
      await server.prompt(sessionId, 'waiting')
      await server.waitFor(() => server.requests.length > 0)
      expect(server.notifications.at(-1)?.update).toMatchObject({ state: 'requires_action' })
      await server.agent.request(acp.methods.agent.session.close, { sessionId })
      expect(server.notifications.at(-1)?.update).toMatchObject({
        state: 'idle',
        stopReason: 'cancelled',
      })
      await server.finish()
    } finally {
      await server.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it('admits queued prompts in order, pins each turn model and keeps repeated tool calls distinct', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-fifo-'))
    const server = launch(cwd, 'hold')
    try {
      await server.initialize()
      const { sessionId } = await server.newSession()
      const first = await server.prompt(sessionId, 'first')
      await server.waitFor(() => server.requests.length === 1)
      await server.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'model',
        type: 'id',
        value: '["fixture","beta"]',
      })
      await server.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'reasoning_effort',
        type: 'id',
        value: 'low',
      })
      const second = server.prompt(sessionId, 'repeat')
      const third = server.prompt(sessionId, 'repeat')
      await server.agent.request(acp.methods.agent.session.list, {})
      expect(
        server.notifications
          .map((n) => n.update)
          .filter(acp.SessionUpdate.isUserMessage)
          .map((m) => m.messageId),
      ).toEqual([first.messageId])
      server.allowPermissions()
      const accepted = await Promise.all([second, third])
      await server.waitFor(
        () =>
          server.notifications.filter(
            (n) => acp.SessionUpdate.isStateUpdate(n.update) && acp.StateUpdate.isIdle(n.update),
          ).length === 3,
      )
      expect(
        server.notifications
          .map((n) => n.update)
          .filter(acp.SessionUpdate.isUserMessage)
          .map((m) => m.messageId),
      ).toEqual([first.messageId, ...accepted.map((m) => m.messageId)])
      const messages = server.notifications
        .map((n) => n.update)
        .filter(acp.SessionUpdate.isAgentMessage)
      expect(JSON.stringify(messages[0])).toContain('model=alpha; effort=high')
      expect(JSON.stringify(messages[1])).toContain('model=beta; effort=low')
      expect(JSON.stringify(messages[2])).toContain('turns=3')
      const calls = server.notifications
        .map((n) => n.update)
        .filter(acp.SessionUpdate.isToolCallUpdate)
        .filter((c) => c.status === 'in_progress')
      expect(new Set(calls.map((c) => c.toolCallId)).size).toBe(3)
      for (const request of server.requests) {
        if (request.subject != null && acp.RequestPermissionSubject.isToolCall(request.subject))
          expect(calls.map((c) => c.toolCallId)).toContain(request.subject.toolCall.toolCallId)
      }
      await server.finish()
    } finally {
      await server.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it('restores an unused model and effort change after disconnecting during a turn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-pending-model-'))
    let server = launch(cwd, 'hold')
    try {
      await server.initialize()
      const { sessionId } = await server.newSession()
      await server.prompt(sessionId, 'before disconnect')
      await server.waitFor(() => server.requests.length > 0)
      for (const [configId, value] of [
        ['model', '["fixture","beta"]'],
        ['reasoning_effort', 'low'],
      ] as const) {
        await server.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId,
          type: 'id',
          value,
        })
      }
      await server.finish()

      server = launch(cwd)
      await server.initialize()
      await server.agent.request(acp.methods.agent.session.resume, { sessionId, cwd, mcpServers })
      await server.idle(sessionId)
      const start = server.notifications.length
      await server.prompt(sessionId, 'after restart')
      await server.idle(sessionId, start)
      expect(reply(server.notifications.slice(start))).toContain('model=beta; effort=low')
      await server.finish()
    } finally {
      await server.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it('replaces MCP mounts on active resume and preserves them when declarations are invalid', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-mounts-'))
    const server = launch(cwd)
    try {
      await server.initialize()
      const { sessionId } = await server.newSession()
      await server.agent.request(acp.methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers: [],
      })
      await server.idle(sessionId)
      let start = server.notifications.length
      await server.prompt(sessionId, 'without-mcp')
      await server.idle(sessionId, start)
      expect(reply(server.notifications.slice(start))).not.toContain('tool=5')
      await server.agent.request(acp.methods.agent.session.resume, { sessionId, cwd, mcpServers })
      await expect(
        server.agent.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd,
          mcpServers: [...mcpServers, ...mcpServers],
        }),
      ).rejects.toMatchObject({ code: -32602 })
      start = server.notifications.length
      await server.prompt(sessionId, 'with-mcp')
      await server.idle(sessionId, start)
      expect(reply(server.notifications.slice(start))).toContain('tool=5')
      await server.finish()
    } finally {
      await server.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it.each(['allow', 'hold'] as const)(
    'cancels a held prompt without interrupting autonomous work with %s permissions',
    async (permissions) => {
      const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-autonomous-cancel-'))
      const server = launch(cwd, permissions, [autonomousPatch])
      try {
        await server.initialize()
        const { sessionId } = await server.newSession()
        await server.startAutonomous(sessionId)
        const start = server.notifications.length
        const abort = new AbortController()
        const pending = server.prompt(sessionId, 'must-not-insert', abort.signal)
        const cancelled = expect(pending).rejects.toMatchObject({ code: -32800 })
        await server.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'model',
          type: 'id',
          value: '["fixture","alpha"]',
        })
        abort.abort()
        await cancelled
        await server.agent.request(acp.methods.agent.session.resume, { sessionId, cwd, mcpServers })
        expect(server.assertStateBeforeResponse()).toMatchObject({
          sessionUpdate: 'state_update',
          state: permissions === 'hold' ? 'requires_action' : 'running',
        })
        expect(
          server.notifications
            .slice(start)
            .some(
              (n) => acp.SessionUpdate.isStateUpdate(n.update) && acp.StateUpdate.isIdle(n.update),
            ),
        ).toBe(false)
        expect(
          server.notifications.slice(start).some((n) => acp.SessionUpdate.isUserMessage(n.update)),
        ).toBe(false)
        if (permissions === 'allow') {
          const next = server.prompt(sessionId, 'after-autonomous')
          await writeFile(join(cwd, 'release'), '')
          await next
          await server.waitFor(() => reply(server.notifications).includes('tool=5; turns=2'))
          await server.idle(sessionId, server.notifications.length - 1)
          const reasons = server.notifications
            .map((n) => n.update)
            .flatMap((update) =>
              acp.SessionUpdate.isStateUpdate(update) && acp.StateUpdate.isIdle(update)
                ? [update.stopReason]
                : [],
            )
          expect(reasons).toEqual(['end_turn', 'end_turn'])
        }
        await server.agent.request(acp.methods.agent.session.close, { sessionId })
        await server.finish()
      } finally {
        await server.stop()
        await rm(cwd, { recursive: true, force: true })
      }
    },
    30_000,
  )

  it('rejects an invalid held prompt without changing the autonomous outcome', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-autonomous-invalid-'))
    const server = launch(cwd, 'allow', [autonomousPatch])
    try {
      await server.initialize()
      const { sessionId } = await server.newSession()
      await server.startAutonomous(sessionId)
      const invalid = server.prompt(sessionId, '').catch((error: unknown) => error)
      await server.agent.request(acp.methods.agent.session.resume, { sessionId, cwd, mcpServers })
      expect(server.assertStateBeforeResponse()).toMatchObject({ state: 'running' })
      await writeFile(join(cwd, 'release'), '')
      expect(await invalid).toMatchObject({ code: -32602 })
      await server.idle(sessionId)
      expect(reply(server.notifications)).toContain('tool=5; turns=1')
      expect(server.notifications.at(-1)?.update).toMatchObject({
        state: 'idle',
        stopReason: 'end_turn',
      })
      await server.finish()
    } finally {
      await server.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it.each(['allow', 'hold'] as const)(
    'closes autonomous work with %s permissions after sending its cancellation state',
    async (permissions) => {
      const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-autonomous-close-'))
      const server = launch(cwd, permissions, [autonomousPatch])
      try {
        await server.initialize()
        const { sessionId } = await server.newSession()
        await server.startAutonomous(sessionId)
        await server.agent.request(acp.methods.agent.session.close, { sessionId })
        expect(server.assertStateBeforeResponse()).toMatchObject({
          state: 'idle',
          stopReason: 'cancelled',
        })
        await server.idle(sessionId)
        const count = server.notifications.length
        await server.agent.request(acp.methods.agent.session.list, {})
        expect(server.notifications).toHaveLength(count)
        await server.finish()
      } finally {
        await server.stop()
        await rm(cwd, { recursive: true, force: true })
      }
    },
    30_000,
  )

  it('drains active work on EOF and can resume the persisted session in another process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-eof-'))
    let server = launch(cwd)
    try {
      await server.initialize()
      const { sessionId } = await server.newSession()
      const accepted = await server.prompt(sessionId, 'cancel')
      await server.waitFor(() =>
        server.notifications.some(
          (n) => acp.SessionUpdate.isToolCallUpdate(n.update) && n.update.status === 'completed',
        ),
      )
      await server.finish()
      server = launch(cwd)
      await server.initialize()
      await server.agent.request(acp.methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers,
        replayFrom: { type: 'start' },
      })
      await server.idle(sessionId)
      expect(server.notifications.map((n) => n.update)).toContainEqual(
        expect.objectContaining({ sessionUpdate: 'user_message', messageId: accepted.messageId }),
      )
      const start = server.notifications.length
      await server.prompt(sessionId, 'after-disconnect')
      await server.idle(sessionId, start)
      expect(reply(server.notifications.slice(start))).toContain('turns=2')
      await server.finish()
    } finally {
      await server.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)
})
