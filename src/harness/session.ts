/** Direct Harness session ownership, queued admission and quiescent completion. */
import type { Context } from '@deepseek-ai/cordis'
import { RequestError } from '@agentclientprotocol/sdk'
import type { Agent, AgentHandle, AgentStatus, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import { AcpContentError, admitAcpPrompt } from './content.js'
import { AcpModelControl } from './model.js'
import { AssistantStream } from './stream.js'
import {
  PERMISSION_CONFIG_ID,
  permissionConfigOptions,
  setPermissionConfig,
} from './permissions.js'
import { untilAborted } from './abort.js'
import type { McpMount } from './mcp.js'
import type {
  Activity,
  McpConfiguration,
  ConfigOption,
  Outcome,
  PromptContent,
  RuntimeOutput,
  RuntimeUpdate,
} from './types.js'

interface Descendants {
  waitForChildren(agent: Agent): Promise<boolean>
  drainDescendants(agents: readonly Agent[]): Promise<void>
}

interface Submission {
  content: readonly PromptContent[]
  imageEnabled: boolean
  accepted: PromiseWithResolvers<string>
  done: PromiseWithResolvers<Outcome>
  abort: AbortController
  removeListener(): void
  id?: string
  inserted: boolean
}

export interface PromptOperation {
  accepted: Promise<string>
  done: Promise<Outcome>
}

export class HarnessSession {
  readonly agent: Agent
  private readonly model: AcpModelControl
  private optionTail = Promise.resolve()
  private tail = Promise.resolve()
  private readonly queue: Submission[] = []
  private current: Submission | undefined
  private pump: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private ended: TurnEndReason | undefined
  private agentError: Error | undefined
  private outputError: Error | undefined
  private activity: Activity = { state: 'idle' }
  private activityAbort = new AbortController()
  private readonly waitingPermissions = new Set<string>()
  private readonly activeTools = new Set<string>()
  private autonomous: Promise<void> | undefined
  private ready = false
  private syncTail = Promise.resolve()
  private buffered: RuntimeUpdate[] | undefined
  private configurationTail = Promise.resolve()
  private readonly lifetime = new AbortController()
  private readonly stream = new AssistantStream()

  constructor(
    private readonly ctx: Context,
    private readonly handle: AgentHandle,
    private readonly mcp: McpMount,
    private mcpServers: readonly McpConfiguration[],
    private readonly output: RuntimeOutput,
  ) {
    this.agent = handle.agent
    this.model = new AcpModelControl(ctx.llm, this.agent.model)
  }

  get session(): Session {
    return this.agent.session
  }

  activate(): void {
    this.ready = true
  }

  async configOptions(signal?: AbortSignal): Promise<ConfigOption[]> {
    return [
      ...(await this.model.options(signal)),
      ...permissionConfigOptions(this.ctx, this.session),
    ]
  }

  setConfig(id: string, value: unknown, requestSignal: AbortSignal): Promise<ConfigOption[]> {
    this.assertOpen()
    const signal = AbortSignal.any([requestSignal, this.lifetime.signal])
    const operation = this.optionTail.then(async () => {
      signal.throwIfAborted()
      if (id === PERMISSION_CONFIG_ID) {
        setPermissionConfig(this.ctx, this.session, value)
        await this.ctx.sessions.flush(this.session)
        signal.throwIfAborted()
        return this.configOptions(signal)
      }
      return [
        ...(await this.model.set(id, value, signal)),
        ...permissionConfigOptions(this.ctx, this.session),
      ]
    })
    this.optionTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  replaceMcp(servers: readonly McpConfiguration[], requestSignal: AbortSignal): Promise<void> {
    this.assertOpen()
    const active = this.current?.done.promise
    const signal = AbortSignal.any([requestSignal, this.lifetime.signal])
    const operation = this.configurationTail.then(async () => {
      if (JSON.stringify(this.mcpServers) === JSON.stringify(servers)) return
      if (active !== undefined) await untilAborted(active, signal)
      await untilAborted(this.waitForQuiescence(), signal)
      signal.throwIfAborted()
      await this.mcp.replace(servers)
      this.mcpServers = servers
    })
    this.configurationTail = operation.catch(() => undefined)
    return operation
  }

  submit(
    content: readonly PromptContent[],
    imageEnabled: boolean,
    signal: AbortSignal,
    queueWhileBusy: boolean,
  ): PromptOperation {
    this.assertOpen()
    if (!queueWhileBusy && (!this.isForegroundIdle() || this.queue.length > 0)) {
      throw RequestError.invalidParams(undefined, 'a prompt is already in flight for this session')
    }
    const accepted = Promise.withResolvers<string>()
    const done = Promise.withResolvers<Outcome>()
    const abort = new AbortController()
    const submission: Submission = {
      content,
      imageEnabled,
      accepted,
      done,
      abort,
      inserted: false,
      removeListener: () => signal.removeEventListener('abort', onAbort),
    }
    const onAbort = (): void => {
      // V2 request cancellation cannot withdraw an already inserted message.
      if (queueWhileBusy && submission.inserted) return
      abort.abort(RequestError.requestCancelled())
      if (this.current === submission) this.cancelCurrent()
      else this.rejectQueued(submission)
    }
    // A v1 caller waits for completion rather than reading the acceptance promise.
    void accepted.promise.catch(() => undefined)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    this.queue.push(submission)
    this.startPump()
    return { accepted: accepted.promise, done: done.promise }
  }

  cancel(): void {
    for (const pending of this.queue.splice(0)) this.rejectQueued(pending)
    this.cancelCurrent()
  }

  private rejectQueued(pending: Submission): void {
    pending.abort.abort(RequestError.requestCancelled())
    pending.accepted.reject(RequestError.requestCancelled())
    pending.done.resolve({ reason: 'cancelled' })
    pending.removeListener()
  }

  private cancelCurrent(): void {
    this.current?.abort.abort(RequestError.requestCancelled())
    this.activityAbort.abort(RequestError.requestCancelled())
    this.agent.cancel({ kind: 'user' })
  }

  private startPump(): void {
    if (this.pump !== undefined) return
    this.pump = this.processQueue().finally(() => {
      this.pump = undefined
      if (this.queue.length > 0 && this.closing === undefined) this.startPump()
    })
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const submission = this.queue[0]!
      let failure: unknown
      try {
        await this.admit(submission)
        await this.waitForQuiescence()
        await this.ctx.sessions.flush(this.session)
      } catch (error) {
        failure = error
        if (this.current === submission) {
          this.agent.cancel({ kind: 'user' })
          try {
            await this.agent.whenIdle()
            this.model.finishTurn()
          } catch (idleError) {
            failure = new AggregateError([error, idleError])
          }
        }
      }
      const outcome: Outcome = isAborted(submission.abort.signal)
        ? { reason: 'cancelled' }
        : failure !== undefined
          ? { reason: 'error', error: toError(failure) }
          : this.result()
      if (!submission.inserted) {
        const rejection =
          outcome.reason === 'cancelled'
            ? RequestError.requestCancelled()
            : failure instanceof AcpContentError && failure.kind === 'invalid'
              ? RequestError.invalidParams(undefined, failure.message)
              : RequestError.internalError(
                  undefined,
                  outcome.reason === 'error' ? outcome.error.message : 'prompt was not inserted',
                )
        submission.accepted.reject(rejection)
      }
      if (this.current === submission) {
        if (this.activity.state !== 'idle') await this.setActivity({ state: 'idle', outcome })
        await this.tail
        this.current = undefined
      } else if (this.queue[0] === submission) {
        this.queue.shift()
      }
      submission.removeListener()
      submission.done.resolve(outcome)
    }
  }

  private isForegroundIdle(): boolean {
    return (
      this.current === undefined &&
      this.agent.status === 'idle' &&
      this.activity.state === 'idle' &&
      this.autonomous === undefined
    )
  }

  /** A held request owns no foreground work until the synchronous followup handoff. */
  private async admit(submission: Submission): Promise<void> {
    const signal = submission.abort.signal
    for (;;) {
      const configuration = this.configurationTail
      await untilAborted(configuration, signal)
      await untilAborted(this.waitForQuiescence(), signal)
      if (this.autonomous !== undefined) await untilAborted(this.autonomous, signal)
      signal.throwIfAborted()
      if (configuration !== this.configurationTail || !this.isForegroundIdle()) continue
      this.mcp.assertReady()
      const selection = this.model.selected
      const content = await admitAcpPrompt(
        this.ctx,
        selection,
        submission.content,
        submission.imageEnabled,
        signal,
      )
      signal.throwIfAborted()
      // Image admission can await I/O while Harness starts an independent turn.
      if (configuration !== this.configurationTail || !this.isForegroundIdle()) continue
      if (!this.model.matches(selection)) continue
      if (this.ctx.agents.get(this.agent.id) !== this.agent)
        throw new Error('the Harness agent is no longer active')
      const message = createUserMessage({ content, source: { kind: 'user' } })
      this.queue.shift()
      this.current = submission
      this.ended = undefined
      this.agentError = undefined
      this.activityAbort = submission.abort
      submission.id = message.id
      this.model.beginTurn()
      this.agent.followup(message)
      return
    }
  }

  private result(): Outcome {
    const error = this.outputError ?? this.agentError
    if (error !== undefined) return { reason: 'error', error }
    const end = this.ended
    if (end?.kind === 'error')
      return { reason: 'error', error: new Error(`turn failed: ${end.error.message}`) }
    if (end?.kind === 'max-tokens') return { reason: 'max_tokens' }
    if (end?.kind === 'interrupted') return { reason: 'cancelled' }
    return { reason: 'end_turn' }
  }

  /** whenIdle also waits for the driver to retire after error/status events. */
  private async waitForQuiescence(): Promise<void> {
    const children = this.ctx.get('subagents') as Descendants | undefined
    for (;;) {
      await this.agent.whenIdle()
      const seq = this.session.seq
      const signal = this.activityAbort.signal
      if (children !== undefined && !signal.aborted) {
        try {
          if (await untilAborted(children.waitForChildren(this.agent), signal)) continue
        } catch (error) {
          if (!isAborted(signal)) throw error
        }
      }
      if (signal.aborted) {
        await children?.drainDescendants([this.agent])
        await this.agent.whenIdle()
      }
      await this.tail
      if (this.agent.status === 'idle' && this.session.seq === seq) {
        this.model.finishTurn()
        return
      }
    }
  }

  onEvent(event: SessionEvent): void {
    if (!this.ready) return
    if (event.type === 'turn/start') {
      this.model.beginTurn()
      this.ended = undefined
      this.activeTools.clear()
      if (this.activity.state === 'idle') {
        if (this.current === undefined) this.activityAbort = new AbortController()
        void this.setActivity({ state: 'running' })
      }
    }
    if (event.type === 'user/message' && event.data.id === this.current?.id) {
      this.current.inserted = true
      this.current.accepted.resolve(event.data.id)
    }
    if (event.type === 'turn/end') {
      this.ended = event.data.reason
      this.agentError = undefined
    }
    const assistant =
      event.type === 'assistant/message' || event.type === 'assistant/attempt'
        ? this.stream.event(event)
        : undefined
    void this.enqueue({ type: 'event', event, replay: false, assistant })
    if (event.type === 'tool/call') this.activeTools.add(event.data.callId)
    if (event.type === 'tool/result') {
      this.activeTools.delete(event.data.message.toolCallId)
      void this.permissionState()
    }
  }

  onError(error: unknown): void {
    this.agentError = toError(error)
  }

  onStream(frame: AssistantStreamFrame): void {
    if (!this.ready) return
    const chunk = this.stream.frame(frame)
    if (chunk !== undefined) void this.enqueue(chunk)
  }

  onStatus(status: AgentStatus): void {
    if (!this.ready || this.closing !== undefined || this.current !== undefined) return
    if (status === 'running' && this.activity.state === 'idle') {
      this.activityAbort = new AbortController()
      void this.setActivity({ state: 'running' })
    }
    if (status === 'idle' && this.activity.state !== 'idle' && this.autonomous === undefined) {
      this.autonomous = this.waitForQuiescence()
        .then(async () => {
          await this.setActivity({
            state: 'idle',
            outcome: this.activityAbort.signal.aborted ? { reason: 'cancelled' } : this.result(),
          })
        })
        .catch((error: unknown) => this.output.fail(error))
        .finally(() => {
          this.autonomous = undefined
        })
    }
  }

  projection(key: string, value: unknown): void {
    if (!this.ready || this.closing !== undefined) return
    if (key === 'permissions') this.configurationChanged()
    if (key === 'title') void this.enqueue({ type: 'title', title: value as string | null })
    if (key === 'todos')
      void this.enqueue({ type: 'plan', todos: value as readonly TodoItem[] | null })
  }

  synchronize(includeState: boolean, requestSignal?: AbortSignal, replay = false): Promise<void> {
    const signal =
      requestSignal === undefined
        ? this.lifetime.signal
        : AbortSignal.any([requestSignal, this.lifetime.signal])
    const operation = this.syncTail.then(async () => {
      this.assertOpen()
      signal.throwIfAborted()
      const through = this.session.seq
      const buffered: RuntimeUpdate[] = []
      this.buffered = buffered
      const send = (update: RuntimeUpdate) => this.output.send(this.session, update)
      const drain = async (): Promise<void> => {
        for (let update = buffered.shift(); update !== undefined; update = buffered.shift())
          await send(update)
      }
      try {
        await this.tail
        if (replay) {
          await this.ctx.sessions.flush(this.session)
          await using handle = await this.ctx.sessionPersistence.open(this.session.id, 'read', {
            signal,
          })
          const { events } = await handle.read(0, through, { signal })
          const replayStream = new AssistantStream()
          for (const event of events) {
            signal.throwIfAborted()
            const assistant =
              event.type === 'assistant/message' || event.type === 'assistant/attempt'
                ? replayStream.event(event)
                : undefined
            await send({ type: 'event', event, replay: true, assistant })
          }
        }
        await drain()
        // Capture together before awaits; later live changes follow this snapshot.
        const snapshot = this.ctx.sessionProjections.snapshot(this.session, ['title', 'todos'])
        const activity = this.activity
        if (snapshot.values.title != null)
          await send({ type: 'title', title: snapshot.values.title })
        if (snapshot.values.todos !== undefined)
          await send({ type: 'plan', todos: snapshot.values.todos })
        if (includeState) await send({ type: 'state', activity })
        await drain()
      } finally {
        this.buffered = undefined
        for (const update of buffered) void this.enqueue(update)
      }
    })
    this.syncTail = operation.catch(() => undefined)
    return operation
  }

  async permission(
    callId: string,
    title: string,
    requestSignal?: AbortSignal,
  ): Promise<'allowed-once' | 'rejected' | 'cancelled'> {
    const signal =
      requestSignal === undefined
        ? this.activityAbort.signal
        : AbortSignal.any([requestSignal, this.activityAbort.signal])
    try {
      await untilAborted(this.syncTail, signal)
      await untilAborted(this.tail, signal)
      this.waitingPermissions.add(callId)
      await this.permissionState()
      return await untilAborted(this.output.permission(this.session, callId, title, signal), signal)
    } catch (error) {
      if (isAborted(signal)) return 'cancelled'
      throw error
    } finally {
      this.waitingPermissions.delete(callId)
      await this.permissionState()
    }
  }

  private async permissionState(): Promise<void> {
    if (this.activity.state === 'idle' || this.activityAbort.signal.aborted) return
    const blocked =
      this.waitingPermissions.size > 0 &&
      [...this.activeTools].every((id) => this.waitingPermissions.has(id))
    const state = blocked ? 'requires_action' : 'running'
    if (state !== this.activity.state) await this.setActivity({ state })
  }

  configurationChanged(): void {
    void this.configOptions(this.lifetime.signal)
      .then((options) => {
        if (this.ready && this.closing === undefined)
          return this.enqueue({ type: 'config', options })
      })
      .catch((error: unknown) => {
        if (this.closing === undefined)
          this.ctx.logger.warn(`dsh-acp: configuration refresh failed: ${errorChain(error)}`)
      })
  }

  private setActivity(activity: Activity): Promise<void> {
    this.activity = activity
    return this.enqueue({ type: 'state', activity })
  }

  private enqueue(update: RuntimeUpdate): Promise<void> {
    if (this.buffered !== undefined) {
      this.buffered.push(update)
      return Promise.resolve()
    }
    const write = this.tail.then(() => this.output.send(this.session, update))
    this.tail = write.catch((error: unknown) => {
      this.outputError ??= toError(error)
      this.cancelCurrent()
      this.output.fail(error)
    })
    return this.tail
  }

  private assertOpen(): void {
    if (this.closing !== undefined)
      throw RequestError.invalidParams(undefined, 'session is closing')
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const closed = Promise.withResolvers<undefined>()
    this.closing = closed.promise
    void this.dispose().then(() => closed.resolve(undefined), closed.reject)
    return this.closing
  }

  private async dispose(): Promise<void> {
    this.lifetime.abort(RequestError.requestCancelled())
    this.cancel()
    const failures: unknown[] = []
    for (const operation of [
      async () => {
        await this.pump
        await this.optionTail
        await this.configurationTail
        await this.autonomous
        await this.agent.whenIdle()
        await this.syncTail
        await this.tail
      },
      async () => {
        await (this.ctx.get('subagents') as Descendants | undefined)?.drainDescendants([this.agent])
      },
      async () => {
        this.model.finishTurn()
        await this.ctx.sessions.flush(this.session)
      },
      async () => {
        await this.handle.dispose()
      },
    ]) {
      try {
        await operation()
      } catch (error) {
        failures.push(error)
      }
    }
    this.ready = false
    if (this.activity.state !== 'idle')
      await this.setActivity({ state: 'idle', outcome: { reason: 'cancelled' } })
    await this.tail
    if (failures.length > 0) throw new AggregateError(failures, failures.map(errorChain).join('; '))
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Abort signals can change during any awaited model, tool or transport operation. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}
