/** Public Harness services shared by both version-specific ACP handlers. */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { RequestError } from '@agentclientprotocol/sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type { DshAcpConfig } from '../config.js'
import { supportsAcpImagePrompts } from './content.js'
import { mountAcpMcpServers, type McpMount } from './mcp.js'
import { HarnessSession } from './session.js'
import type { McpConfiguration, RuntimeOutput } from './types.js'

export interface SessionSetup {
  cwd: string
  mcpServers: readonly McpConfiguration[]
  additionalDirectories?: readonly string[] | null
}

export class HarnessRuntime {
  private readonly records = new Map<string, HarnessSession>()
  private readonly activating = new Set<string>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly abort = new AbortController()
  private closing: Promise<void> | undefined
  private output: RuntimeOutput | undefined
  imageEnabled = false

  /** Aborts local writes and waits when this connection is no longer usable. */
  get signal(): AbortSignal {
    return this.abort.signal
  }

  constructor(
    readonly ctx: Context,
    readonly config: DshAcpConfig,
  ) {
    ctx.on('session/event', (session, event) => {
      const record = this.records.get(session.id)
      if (record?.session === session) record.onEvent(event)
    })
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      const record = this.records.get(agent.session.id)
      if (record?.agent === agent) record.onStream(frame)
    })
    ctx.on('agent/error', ({ agent, error }) => {
      const record = this.records.get(agent.session.id)
      if (record?.agent === agent) record.onError(error)
    })
    ctx.on('agent/status', ({ agent, status }) => {
      const record = this.records.get(agent.session.id)
      if (record?.agent === agent) record.onStatus(status)
    })
    ctx.effect(() =>
      ctx.sessionProjections.onChanged((session, key, value) => {
        const record = this.records.get(session.id)
        if (record?.session === session) record.projection(key, value)
      }),
    )
    ctx.on('llm/adapters-updated', () => {
      for (const record of this.records.values()) record.configurationChanged()
    })
    ctx.on('permission-presets/catalog-changed', () => {
      for (const record of this.records.values()) record.configurationChanged()
    })
    ctx.on('approval/request', (request, next) => {
      const record = this.records.get(request.agent.session.id)
      if (record?.agent !== request.agent || request.callId === undefined) return next()
      return record.permission(
        request.callId,
        request.reason ?? 'Allow this tool call?',
        request.signal,
      )
    })
  }

  async initialize(output: RuntimeOutput): Promise<void> {
    this.imageEnabled = await supportsAcpImagePrompts(
      this.ctx,
      this.config.provider,
      this.config.model,
    )
    this.abort.signal.throwIfAborted()
    this.output = output
  }

  require(id: string): HarnessSession {
    this.assertOpen()
    const record = this.records.get(id)
    if (record === undefined)
      throw new RequestError(-32002, `Unknown session: ${id}`, { sessionId: id })
    return record
  }

  cancel(id: string): void {
    this.records.get(id)?.cancel()
  }

  create(params: SessionSetup, signal: AbortSignal): Promise<HarnessSession> {
    return this.track(() => this.activate(undefined, params, signal))
  }

  resume(id: string, params: SessionSetup, signal: AbortSignal): Promise<HarnessSession> {
    return this.track(async () => {
      this.assertOpen()
      validateWorkspace(params)
      const existing = this.records.get(id)
      if (existing !== undefined) {
        if (!(await sameDirectory(existing.session.header.cwd, params.cwd)))
          throw RequestError.invalidParams(undefined, 'session cwd does not match')
        await existing.replaceMcp(params.mcpServers, AbortSignal.any([signal, this.abort.signal]))
        return existing
      }
      return this.activate(id, params, signal)
    })
  }

  private async activate(
    id: string | undefined,
    params: SessionSetup,
    requestSignal: AbortSignal,
  ): Promise<HarnessSession> {
    this.assertOpen()
    validateWorkspace(params)
    const output = this.output!
    const signal = AbortSignal.any([requestSignal, this.abort.signal])
    const sessionId = brandString<SessionId>(id ?? randomUUID())
    if (this.activating.has(sessionId) || this.ctx.sessions.get(sessionId) !== undefined)
      throw RequestError.invalidParams(undefined, 'session is already active')
    this.activating.add(sessionId)
    let record: HarnessSession | undefined
    try {
      if (id !== undefined) {
        const stored = await this.ctx.sessionPersistence.stat(sessionId, { signal })
        if (stored === undefined || stored.header.origin === 'subagent')
          throw new RequestError(-32002, `Unknown session: ${id}`)
        if (!(await sameDirectory(stored.header.cwd, params.cwd)))
          throw RequestError.invalidParams(undefined, 'session cwd does not match')
      }
      let mcp: McpMount | undefined
      const agentOptions = {
        ...(this.config.provider === undefined ? {} : { provider: this.config.provider }),
        ...(this.config.model === undefined ? {} : { model: this.config.model }),
      }
      const setup = async (agentCtx: Context): Promise<void> => {
        installModelSelection(agentCtx)
        mcp = await mountAcpMcpServers(agentCtx, params.mcpServers, params.cwd)
      }
      const handle =
        id === undefined
          ? await this.ctx.agents.create({
              sessionId,
              meta: { cwd: params.cwd },
              agentOptions,
              signal,
              setup,
            })
          : await this.ctx.agents.resume({
              resumeSessionId: sessionId,
              agentOptions,
              signal,
              setup,
            })
      record = new HarnessSession(this.ctx, handle, mcp!, params.mcpServers, output)
      signal.throwIfAborted()
      this.records.set(sessionId, record)
      await record.configOptions(signal)
      await this.ctx.sessions.flush(record.session)
      signal.throwIfAborted()
      record.activate()
      return record
    } catch (error) {
      this.records.delete(sessionId)
      await record?.close()
      throw error
    } finally {
      this.activating.delete(sessionId)
    }
  }

  async list(
    params: { cwd?: string | null; cursor?: string | null },
    signal: AbortSignal,
    includeActive: boolean,
  ) {
    this.assertOpen()
    if (params.cwd != null && !isAbsolute(params.cwd))
      throw RequestError.invalidParams(undefined, 'cwd must be absolute')
    const cursor = decodeCursor(params.cursor)
    const stored = await this.ctx.sessionPersistence.list({ signal })
    const candidates = await Promise.all(
      stored.map(async ({ header }) => {
        if (
          (!includeActive && this.records.has(header.id)) ||
          this.activating.has(header.id) ||
          header.origin === 'subagent' ||
          header.cwd === undefined ||
          !isAbsolute(header.cwd)
        )
          return undefined
        if (params.cwd != null && !(await sameDirectory(header.cwd, params.cwd))) return undefined
        const live = this.records.get(header.id)
        const title =
          live !== undefined
            ? this.ctx.sessionProjections.snapshot(live.session, ['title']).values.title
            : (
                this.ctx.sessionProjectionCache.cachedSnapshot(header, ['title']) ??
                this.ctx.sessionProjectionCache.cachedPredecessorTitle(header)
              )?.values.title
        return {
          sessionId: header.id,
          cwd: header.cwd,
          createdAt: header.createdAt,
          ...(title == null ? {} : { title }),
        }
      }),
    )
    const ordered = candidates
      .filter((entry) => entry !== undefined)
      .sort(
        (a, b) =>
          b.createdAt - a.createdAt ||
          Buffer.compare(Buffer.from(a.sessionId), Buffer.from(b.sessionId)),
      )
    const remaining =
      cursor === undefined
        ? ordered
        : ordered.filter(
            (entry) =>
              entry.createdAt < cursor[0] ||
              (entry.createdAt === cursor[0] &&
                Buffer.compare(Buffer.from(entry.sessionId), Buffer.from(cursor[1])) > 0),
          )
    const page = remaining.slice(0, this.config.sessionListPageSize ?? 100)
    const last = remaining.length > page.length ? page.at(-1) : undefined
    return {
      sessions: page.map(({ sessionId, cwd, ...rest }) => ({
        sessionId,
        cwd,
        ...(rest.title === undefined ? {} : { title: rest.title }),
      })),
      ...(last === undefined
        ? {}
        : {
            nextCursor: Buffer.from(JSON.stringify([last.createdAt, last.sessionId])).toString(
              'base64url',
            ),
          }),
    }
  }

  async closeSession(id: string): Promise<void> {
    const record = this.require(id)
    try {
      await record.close()
    } finally {
      if (this.records.get(id) === record) this.records.delete(id)
    }
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.abort.abort(new Error('ACP connection closed'))
    for (const record of this.records.values()) record.cancel()
    this.closing = (async () => {
      await Promise.allSettled(this.operations)
      const results = await Promise.allSettled(
        [...this.records.values()].map((record) => record.close()),
      )
      this.records.clear()
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result): unknown => result.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'Harness session teardown failed')
    })()
    return this.closing
  }

  private assertOpen(): void {
    if (this.abort.signal.aborted)
      throw RequestError.internalError(undefined, 'connection is closed')
    if (this.output === undefined)
      throw RequestError.invalidRequest(undefined, 'initialize must complete first')
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const result = operation()
    this.operations.add(result)
    void result.finally(() => this.operations.delete(result)).catch(() => undefined)
    return result
  }
}

function validateWorkspace(params: SessionSetup): void {
  if (!isAbsolute(params.cwd)) throw RequestError.invalidParams(undefined, 'cwd must be absolute')
  if ((params.additionalDirectories?.length ?? 0) > 0)
    throw RequestError.invalidParams(undefined, 'additionalDirectories is not supported')
}

async function sameDirectory(left: string | undefined, right: string): Promise<boolean> {
  if (left === undefined) return false
  try {
    const [a, b] = await Promise.all([realpath(left), realpath(right)])
    return a === b
  } catch (_unresolvableDirectory) {
    return resolve(left) === resolve(right)
  }
}

function decodeCursor(value: string | null | undefined): [number, string] | undefined {
  if (value == null) return undefined
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('encoding')
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString())
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !Number.isSafeInteger(parsed[0]) ||
      parsed[0] < 0 ||
      typeof parsed[1] !== 'string' ||
      parsed[1].length === 0 ||
      Buffer.from(JSON.stringify(parsed)).toString('base64url') !== value
    )
      throw new Error('fields')
    return [parsed[0] as number, parsed[1]]
  } catch (_invalidCursor) {
    throw RequestError.invalidParams(undefined, 'session/list cursor is invalid')
  }
}
