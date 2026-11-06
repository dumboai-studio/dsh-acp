/** Exercise the published launcher and official ACP profile through its wire API. */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  client,
  methods,
  ndJsonStream,
  type McpServer,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
} from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

const bin =
  process.env.DSH_ACP_TEST_BIN ?? fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const patch = fileURLToPath(new URL('./fixtures/official/acp.patch.yml', import.meta.url))
const autonomousPatch = fileURLToPath(
  new URL('./fixtures/official/autonomous.patch.yml', import.meta.url),
)
const mcp = fileURLToPath(new URL('./fixtures/official/mcp.mjs', import.meta.url))
const mcpServers: McpServer[] = [
  { name: 'fixture', command: process.execPath, args: [mcp], env: [] },
]

function launch(cwd: string, patches: string[] = []) {
  const args = [bin, '--patch', patch, ...patches.flatMap((path) => ['--patch', path])]
  const child = spawn(process.execPath, args, {
    cwd,
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
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
  const diagnostics: string[] = []
  const raw: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => diagnostics.push(chunk))
  child.stdout.on('data', (chunk: Buffer) => raw.push(chunk.toString('utf8')))
  const updates: SessionUpdate[] = []
  const notifications: SessionNotification[] = []
  const permissions: RequestPermissionRequest[] = []
  const listeners = new Set<(update: SessionUpdate) => void>()
  const connection = client({ name: 'profile-compatibility-test' })
    .onNotification(methods.client.session.update, ({ params }) => {
      notifications.push(params)
      updates.push(params.update)
      for (const listener of listeners) listener(params.update)
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissions.push(params)
      const option = params.options.find(({ kind }) => kind === 'allow_once')
      if (option === undefined) throw new Error('no allow_once permission option')
      return { outcome: { outcome: 'selected', optionId: option.optionId } }
    })
    .connect(
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    )

  return {
    agent: connection.agent,
    updates,
    notifications,
    permissions,
    waitForUpdate(predicate: (update: SessionUpdate) => boolean) {
      return new Promise<void>((resolve) => {
        const listener = (update: SessionUpdate) => {
          if (!predicate(update)) return
          listeners.delete(listener)
          resolve()
        }
        listeners.add(listener)
      })
    },
    async finish() {
      connection.close()
      child.stdin.end()
      expect(await exited, diagnostics.join('')).toBe(0)
      expect(diagnostics.join('')).toBe('')
      for (const line of raw.join('').trim().split('\n')) {
        expect(JSON.parse(line)).toHaveProperty('jsonrpc', '2.0')
      }
    },
    async stop() {
      connection.close()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    },
  }
}

function selectValue(
  options: SessionConfigOption[] | null | undefined,
  id: string,
  name: string,
): string {
  const option = options?.find((candidate) => candidate.id === id)
  if (option?.type !== 'select') throw new Error(`missing select option: ${id}`)
  const values = option.options.flatMap((candidate) =>
    'group' in candidate ? candidate.options : [candidate],
  )
  const selected = values.find((candidate) => candidate.name === name)
  if (selected === undefined) throw new Error(`missing ${id} value: ${name}`)
  return selected.value
}

function reply(updates: SessionUpdate[]): string {
  return updates
    .flatMap((update) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
        ? [update.content.text]
        : [],
    )
    .join('')
}

describe('direct Harness ACP v1 compatibility', () => {
  it('publishes plans, titles and tool categories by default and restores display after restart', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-display-'))
    await writeFile(join(cwd, 'fixture.txt'), 'fixture content')
    let process = launch(cwd)
    try {
      await process.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      const { sessionId } = await process.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers,
      })
      await expect(
        process.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'plan this task' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' })
      expect(reply(process.updates)).toContain('fixture content')
      expect(process.updates).toContainEqual({
        sessionUpdate: 'session_info_update',
        title: 'plan this task',
      })
      const plans = process.updates.filter((update) => update.sessionUpdate === 'plan')
      expect(plans.at(-2)).toEqual({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read fixture', status: 'in_progress', priority: 'medium' },
          { content: 'Report result', status: 'pending', priority: 'medium' },
        ],
      })
      const finishedPlan = {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read fixture', status: 'completed', priority: 'medium' },
          { content: 'Report result', status: 'completed', priority: 'medium' },
        ],
      }
      expect(plans.at(-1)).toEqual(finishedPlan)
      expect(process.updates).toContainEqual(
        expect.objectContaining({
          sessionUpdate: 'tool_call',
          toolCallId: 'plan-start',
          kind: 'think',
        }),
      )
      expect(process.updates).toContainEqual(
        expect.objectContaining({
          sessionUpdate: 'tool_call',
          toolCallId: 'plan-read',
          kind: 'read',
        }),
      )
      const beforeResume = process.updates.length
      const synchronized = process.waitForUpdate((update) => update.sessionUpdate === 'plan')
      await process.agent.request(methods.agent.session.resume, { sessionId, cwd, mcpServers })
      await synchronized
      expect(reply(process.updates.slice(beforeResume))).toBe('')
      await process.agent.request(methods.agent.session.close, { sessionId })
      await process.finish()
      process = launch(cwd)
      await process.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      expect(await process.agent.request(methods.agent.session.list, { cwd })).toEqual({
        sessions: [{ sessionId, cwd, title: 'plan this task' }],
      })
      const restored = process.waitForUpdate((update) => update.sessionUpdate === 'plan')
      await process.agent.request(methods.agent.session.resume, { sessionId, cwd, mcpServers })
      await restored
      expect(process.updates).toEqual([
        { sessionUpdate: 'session_info_update', title: 'plan this task' },
        finishedPlan,
      ])
      const start = process.updates.length
      await process.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'continue' }],
      })
      expect(
        process.updates.slice(start).filter((update) => update.sessionUpdate === 'plan'),
      ).toEqual([{ sessionUpdate: 'plan', entries: [] }])
      expect(reply(process.updates)).toContain('turns=2')
      await process.agent.request(methods.agent.session.close, { sessionId })
      await process.finish()
    } finally {
      await process.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps history pagination and cwd filtering while adding cached titles', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-list-'))
    const otherCwd = join(cwd, 'other')
    await mkdir(otherCwd)
    await writeFile(join(cwd, 'fixture.txt'), 'fixture content')
    let process = launch(cwd)
    try {
      await process.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      const ids: string[] = []
      for (const text of ['plan first', 'plan second']) {
        const { sessionId } = await process.agent.request(methods.agent.session.new, {
          cwd,
          mcpServers: [],
        })
        ids.push(sessionId)
        await process.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text }],
        })
        await process.agent.request(methods.agent.session.close, { sessionId })
      }
      const untitled = await process.agent.request(methods.agent.session.new, {
        cwd: otherCwd,
        mcpServers: [],
      })
      await process.agent.request(methods.agent.session.close, { sessionId: untitled.sessionId })
      await process.finish()
      process = launch(cwd)
      await process.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      const first = await process.agent.request(methods.agent.session.list, { cwd })
      expect(first.sessions).toEqual([{ sessionId: ids[1], cwd, title: 'plan second' }])
      expect(first.nextCursor).toEqual(expect.any(String))
      expect(
        await process.agent.request(methods.agent.session.list, { cwd, cursor: first.nextCursor! }),
      ).toEqual({ sessions: [{ sessionId: ids[0], cwd, title: 'plan first' }] })
      expect(await process.agent.request(methods.agent.session.list, { cwd: otherCwd })).toEqual({
        sessions: [{ sessionId: untitled.sessionId, cwd: otherCwd }],
      })
      await expect(
        process.agent.request(methods.agent.session.list, { cwd, cursor: 'invalid' }),
      ).rejects.toMatchObject({ code: -32602 })
      expect(process.updates).toEqual([])
      const restored = process.waitForUpdate(
        (update) => update.sessionUpdate === 'session_info_update',
      )
      await process.agent.request(methods.agent.session.resume, {
        sessionId: ids[0]!,
        cwd,
        mcpServers: [],
      })
      await restored
      expect(await process.agent.request(methods.agent.session.list, { cwd })).toEqual({
        sessions: [{ sessionId: ids[1], cwd, title: 'plan second' }],
      })
      await process.agent.request(methods.agent.session.close, { sessionId: ids[0]! })
      await process.finish()
    } finally {
      await process.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it('lists and resumes a 0.7.0 fork while keeping subagent sessions private', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-legacy-fork-'))
    const server = launch(cwd)
    try {
      await server.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      const parent = await server.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
      const root = join(cwd, '.sessions')
      const [project] = await readdir(root)
      const recording = await readFile(
        new URL('./fixtures/official/rc4-fork.jsonl', import.meta.url),
        'utf8',
      )
      const [first, ...events] = recording.split('\n')
      const header = JSON.parse(first!) as Record<string, unknown>
      for (const [id, meta] of [
        ['legacy-fork', {}],
        ['legacy-subagent', { origin: 'subagent', delegationDepth: 1 }],
      ] as const) {
        const dir = join(root, project!, id)
        await mkdir(dir)
        const firstLine = JSON.stringify({
          ...header,
          id,
          cwd,
          parentSession: parent.sessionId,
          ...meta,
        })
        await writeFile(join(dir, 'session.v4.jsonl'), [firstLine, ...events].join('\n'))
      }
      expect(await server.agent.request(methods.agent.session.list, { cwd })).toEqual({
        sessions: [{ sessionId: 'legacy-fork', cwd }],
      })
      await expect(
        server.agent.request(methods.agent.session.resume, {
          sessionId: 'legacy-fork',
          cwd,
          mcpServers: [],
        }),
      ).resolves.toHaveProperty('configOptions')
      await expect(
        server.agent.request(methods.agent.session.resume, {
          sessionId: 'legacy-subagent',
          cwd,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: -32002 })
      await server.finish()
    } finally {
      await server.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it('closes active work without disturbing another session or leaking display updates', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-isolation-'))
    await writeFile(join(cwd, 'fixture.txt'), 'fixture content')
    const process = launch(cwd)
    try {
      await process.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      const a = await process.agent.request(methods.agent.session.new, { cwd, mcpServers })
      const b = await process.agent.request(methods.agent.session.new, { cwd, mcpServers })
      const busy = process.waitForUpdate(
        (update) =>
          update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'fixture-cancel',
      )
      const promptA = process.agent.request(methods.agent.session.prompt, {
        sessionId: a.sessionId,
        prompt: [{ type: 'text', text: 'cancel' }],
      })
      const promptB = process.agent.request(methods.agent.session.prompt, {
        sessionId: b.sessionId,
        prompt: [{ type: 'text', text: 'plan independent task' }],
      })
      await busy
      await process.agent.request(methods.agent.session.close, { sessionId: a.sessionId })
      await expect(promptA).resolves.toEqual({ stopReason: 'cancelled' })
      await expect(promptB).resolves.toEqual({ stopReason: 'end_turn' })
      const before = process.notifications.filter(({ sessionId }) => sessionId === a.sessionId)
      await process.agent.request(methods.agent.session.prompt, {
        sessionId: b.sessionId,
        prompt: [{ type: 'text', text: 'continue' }],
      })
      expect(process.notifications.filter(({ sessionId }) => sessionId === a.sessionId)).toEqual(
        before,
      )
      const titles = process.notifications.filter(
        ({ update }) => update.sessionUpdate === 'session_info_update',
      )
      expect(titles).toContainEqual({
        sessionId: a.sessionId,
        update: { sessionUpdate: 'session_info_update', title: 'cancel' },
      })
      expect(titles).toContainEqual({
        sessionId: b.sessionId,
        update: { sessionUpdate: 'session_info_update', title: 'plan independent task' },
      })
      expect(
        process.notifications
          .filter(
            ({ sessionId, update }) => sessionId === a.sessionId && update.sessionUpdate === 'plan',
          )
          .every(({ update }) => update.sessionUpdate === 'plan' && update.entries.length === 0),
      ).toBe(true)
      // EOF also owns teardown of the second, still-open session.
      await process.finish()
    } finally {
      await process.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)
  it('selects models, requests permission, uses MCP, resumes history and continues after cancellation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-profile-'))
    let process = launch(cwd)
    try {
      const initialized = await process.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      expect(initialized.agentCapabilities).toMatchObject({
        mcpCapabilities: { http: true },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {}, list: {}, resume: {} },
      })
      const session = await process.agent.request(methods.agent.session.new, { cwd, mcpServers })
      const sessionId = session.sessionId
      const selected = await process.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'model',
        value: selectValue(session.configOptions, 'model', 'beta'),
      })
      await process.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'reasoning_effort',
        value: selectValue(selected.configOptions, 'reasoning_effort', 'low'),
      })
      await expect(
        process.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'first' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' })
      expect(reply(process.updates)).toBe('model=beta; effort=low; tool=5; turns=1')
      expect(process.permissions.length).toBeGreaterThan(0)
      expect(process.updates).toContainEqual(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'fixture-first',
          status: 'completed',
        }),
      )
      expect(process.updates).toContainEqual(
        expect.objectContaining({ sessionUpdate: 'usage_update' }),
      )
      await expect(
        process.agent.request(methods.agent.session.load, {
          sessionId,
          cwd,
          mcpServers,
        }),
      ).rejects.toMatchObject({ code: -32601 })
      await process.agent.request(methods.agent.session.close, { sessionId })
      await process.finish()

      process = launch(cwd)
      await process.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      const listed = await process.agent.request(methods.agent.session.list, { cwd })
      expect(listed.sessions).toContainEqual(expect.objectContaining({ sessionId, cwd }))
      const resumed = await process.agent.request(methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers,
      })
      const model = resumed.configOptions?.find(({ id }) => id === 'model')
      expect(model?.currentValue).toBe(selectValue(resumed.configOptions, 'model', 'beta'))
      const toolFinished = process.waitForUpdate(
        (update) =>
          update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'fixture-cancel',
      )
      const prompt = process.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'cancel' }],
      })
      await Promise.race([
        toolFinished,
        prompt.then(() => {
          throw new Error('prompt ended before cancellation')
        }),
      ])
      await process.agent.notify(methods.agent.session.cancel, { sessionId })
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
      await expect(
        process.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'continue' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' })
      expect(reply(process.updates)).toBe('model=beta; effort=low; tool=5; turns=3')
      await process.agent.request(methods.agent.session.close, { sessionId })
      await process.finish()
    } finally {
      await process.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects concurrent v1 prompts while Harness is running an autonomous turn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v1-autonomous-'))
    const server = launch(cwd, [autonomousPatch])
    try {
      await server.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      const { sessionId } = await server.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers,
      })
      const toolFinished = server.waitForUpdate(
        (update) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed',
      )
      await writeFile(join(cwd, 'autonomous.tmp'), JSON.stringify({ sessionId, text: 'gate' }))
      await rename(join(cwd, 'autonomous.tmp'), join(cwd, 'autonomous.json'))
      await toolFinished
      await expect(
        server.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'must-not-insert' }],
        }),
      ).rejects.toMatchObject({ code: -32602 })
      const answered = server.waitForUpdate(
        (update) => update.sessionUpdate === 'agent_message_chunk',
      )
      await writeFile(join(cwd, 'release'), '')
      await answered
      expect(reply(server.updates)).toContain('tool=5; turns=1')
      await server.agent.request(methods.agent.session.close, { sessionId })
      await server.finish()
    } finally {
      await server.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it('accepts the next prompt immediately after a provider failure', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-failure-'))
    const process = launch(cwd)
    try {
      await process.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      const { sessionId } = await process.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers,
      })
      await expect(
        process.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'image', mimeType: 'image/png', data: 'invalid' }],
        }),
      ).rejects.toMatchObject({ code: -32602 })
      await expect(
        process.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'fail' }],
        }),
      ).rejects.toThrow('fixture provider failure')
      await expect(
        process.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'recover' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' })
      expect(reply(process.updates)).toContain('tool=5; turns=2')
      await process.agent.request(methods.agent.session.close, { sessionId })
      await process.finish()
    } finally {
      await process.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)
})
