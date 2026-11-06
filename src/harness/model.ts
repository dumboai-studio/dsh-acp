// Adapted from DeepSeek Harness (MIT); see THIRD_PARTY_NOTICES.md.
/** Standard ACP session configuration over one Agent's model selection. */

import type { SessionConfigOption, SessionConfigValueId } from '@agentclientprotocol/sdk'
import type { Model, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmCallConfig, type LlmRuntime } from '@deepseek-ai/dsh-llm'

const MODEL_CONFIG_ID = 'model'
const REASONING_CONFIG_ID = 'reasoning_effort'
// DSH reasoning effort ids are non-empty, so the empty opaque ACP value is a disjoint provider-default choice.
const PROVIDER_DEFAULT_REASONING_VALUE = ''

interface ModelChoice {
  selection: ModelSelection
  value: SessionConfigValueId
}

interface ConfigState {
  choices: Map<SessionConfigValueId, ModelSelection>
  options: SessionConfigOption[]
}

/** Caller-correctable session configuration failure. */
export class AcpModelConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpModelConfigError'
  }
}

/** Project and mutate one Agent's provider/model/reasoning selection through ACP config options. */
export class AcpModelControl {
  private tail = Promise.resolve()
  private hasResolvedState = false
  private activeTurn = false
  private deferred: ModelSelection | undefined

  constructor(
    private readonly llm: LlmRuntime,
    private readonly route: Model,
  ) {}

  /** The choice shown to the client, including a change queued for the next turn. */
  get selected(): ModelSelection | undefined {
    return this.deferred ?? this.route.current()
  }

  /** Image admission may await I/O while the client selects a different model. */
  matches(choice: ModelSelection | undefined): boolean {
    const selected = this.selected
    return (
      choice?.provider === selected?.provider &&
      choice?.model === selected?.model &&
      choice?.reasoningEffort === selected?.reasoningEffort
    )
  }

  /** Harness reads its model at every step; keep this choice until the turn drains. */
  beginTurn(): void {
    this.activeTurn = true
  }

  finishTurn(): void {
    if (this.deferred !== undefined) {
      this.route.select(this.deferred)
      this.deferred = undefined
    }
    this.activeTurn = false
  }

  /**
   * Return the complete standard config-option state after prior mutations settle.
   * @param signal - optional catalog and exact-model cancellation.
   * @returns all current standard configuration options.
   */
  options(signal?: AbortSignal): Promise<SessionConfigOption[]> {
    return this.serialize(async () => (await this.state(signal)).options)
  }

  /**
   * Set one advertised option and return the complete resulting option state.
   * @param configId - standard option id.
   * @param value - opaque selected value returned by a previous option state.
   * @param signal - optional catalog and exact-model cancellation.
   * @returns all standard options after the serialized mutation.
   */
  set(configId: string, value: unknown, signal?: AbortSignal): Promise<SessionConfigOption[]> {
    return this.serialize(async () => {
      signal?.throwIfAborted()
      if (typeof value !== 'string')
        throw new AcpModelConfigError(`${configId} requires a select value`)
      const current = this.selected
      if (current === undefined)
        throw new AcpModelConfigError('this session has no model selection')
      let selection: ModelSelection
      if (configId === MODEL_CONFIG_ID) {
        const state = await this.state(signal)
        const selected = state.choices.get(value)
        if (selected === undefined) throw new AcpModelConfigError(`unknown model option: ${value}`)
        await this.resolveSelection(selected, signal)
        selection = selected
      } else if (configId === REASONING_CONFIG_ID) {
        const info = await this.llm.resolveModelInfo(current.provider, current.model, signal)
        const providerDefault =
          value === PROVIDER_DEFAULT_REASONING_VALUE && info.reasoning?.defaultEffort === undefined
        if (
          info.reasoning === undefined ||
          (!providerDefault && !info.reasoning.efforts.some((effort) => effort.id === value))
        ) {
          throw new AcpModelConfigError(
            `unknown reasoning effort for ${current.provider}/${current.model}: ${value}`,
          )
        }
        selection = {
          provider: current.provider,
          model: current.model,
          ...(providerDefault ? {} : { reasoningEffort: ReasoningEffortId(value) }),
        }
        await this.resolveSelection(selection, signal)
      } else {
        throw new AcpModelConfigError(`unknown session config option: ${configId}`)
      }
      signal?.throwIfAborted()
      if (this.activeTurn) this.deferred = selection
      else this.route.select(selection)
      return (await this.state(signal)).options
    })
  }

  /** Keep concurrent client mutations in receive order without wedging after rejection. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Build detached model choices and the dependent reasoning option. */
  private async state(signal?: AbortSignal): Promise<ConfigState> {
    const selected = this.selected
    if (selected === undefined) return { choices: new Map(), options: [] }
    let resolved: ModelSelection
    let routeAvailable = true
    try {
      resolved = await this.resolveSelection(selected, signal)
      this.hasResolvedState = true
    } catch (error: unknown) {
      if (!this.hasResolvedState) throw error
      resolved = selected
      routeAvailable = false
    }
    const choices = new Map<SessionConfigValueId, ModelSelection>()
    const groups = await Promise.all(
      this.llm.listProviders().map(async (provider) => {
        try {
          const models = await this.llm.listModels(provider.id)
          const entries = models.map((model) => {
            const choice: ModelChoice = {
              value: modelValue(provider.id, model.id),
              selection: { provider: provider.id, model: model.id },
            }
            choices.set(choice.value, choice.selection)
            return {
              value: choice.value,
              name: model.name,
              ...(model.description === undefined ? {} : { description: model.description }),
            }
          })
          return { group: provider.id, name: provider.name, options: entries }
        } catch (_providerCatalogUnavailable) {
          return { group: provider.id, name: provider.name, options: [] }
        }
      }),
    )
    const currentValue = modelValue(resolved.provider, resolved.model)
    if (!choices.has(currentValue)) {
      choices.set(currentValue, { provider: resolved.provider, model: resolved.model })
      let group = groups.find((item) => item.group === resolved.provider)
      if (group === undefined) {
        group = { group: resolved.provider, name: resolved.provider, options: [] }
        groups.push(group)
      }
      group.options.unshift({ value: currentValue, name: resolved.model })
    }
    const options: SessionConfigOption[] = [
      {
        id: MODEL_CONFIG_ID,
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue,
        options: groups.filter((group) => group.options.length > 0),
      },
    ]
    const info = routeAvailable
      ? await this.llm.resolveModelInfo(resolved.provider, resolved.model, signal)
      : undefined
    if (info?.reasoning !== undefined) {
      options.push({
        id: REASONING_CONFIG_ID,
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue:
          resolved.reasoningEffort === undefined
            ? PROVIDER_DEFAULT_REASONING_VALUE
            : String(resolved.reasoningEffort),
        options: [
          ...(info.reasoning.defaultEffort === undefined
            ? [{ value: PROVIDER_DEFAULT_REASONING_VALUE, name: 'Provider default' }]
            : []),
          ...info.reasoning.efforts.map((effort) => ({
            value: String(effort.id),
            name: effort.name,
            ...(effort.description === undefined ? {} : { description: effort.description }),
          })),
        ],
      })
    }
    return { choices, options }
  }

  /** Validate an exact route and retain only Agent-owned selection fields. */
  private async resolveSelection(
    selection: ModelSelection,
    signal?: AbortSignal,
  ): Promise<ModelSelection> {
    const resolved: LlmCallConfig = await this.llm.resolveCallConfig(selection, signal)
    return {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: resolved.reasoningEffort }),
    }
  }
}

/** Opaque ACP selector value carrying the full route identity. */
function modelValue(provider: string, model: string): SessionConfigValueId {
  return JSON.stringify([provider, model])
}
