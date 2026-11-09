/** ACP permission choices backed by Harness's durable per-session presets. */
import type { Context } from '@deepseek-ai/cordis'
import { RequestError, type SessionConfigOption } from '@agentclientprotocol/sdk'
import { CUSTOM_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'

export const PERMISSION_CONFIG_ID = 'mode'

/** Return the effective selection and live catalog when the profile provides permissions. */
export function permissionConfigOptions(ctx: Context, session: Session): SessionConfigOption[] {
  const presets = ctx.get('permissionPresets')
  if (presets === undefined) return []
  const currentValue = presets.current(session)
  const options = presets.catalog().options
  if (!options.some((option) => option.value === currentValue))
    options.push(presets.optionOf(currentValue))
  return [
    {
      id: PERMISSION_CONFIG_ID,
      name: 'Permissions',
      category: 'mode',
      type: 'select',
      currentValue,
      options,
    },
  ]
}

/** Apply an advertised preset through Harness's sandbox and approval setters. */
export function setPermissionConfig(ctx: Context, session: Session, value: unknown): void {
  const presets = ctx.get('permissionPresets')
  if (presets === undefined)
    throw RequestError.invalidParams(undefined, 'this Harness profile has no permission presets')
  if (typeof value !== 'string')
    throw RequestError.invalidParams(undefined, 'mode requires a select value')
  // Custom describes existing knob values and can only be reselected as a no-op.
  if (value === CUSTOM_PRESET && presets.current(session) === CUSTOM_PRESET) return
  if (!presets.catalog().options.some((option) => option.value === value))
    throw RequestError.invalidParams(undefined, `unknown permission preset: ${value}`)
  presets.set(session, value)
}
