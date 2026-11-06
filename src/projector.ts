/** Pure display mappings; Harness owns the projected state and tool execution. */
import type { SessionUpdate, ToolKind } from '@agentclientprotocol/sdk'
import type { SessionProjectionViewValues } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-tool-todo'

/** Infer a display category for an otherwise generic tool call. */
export function toolKind(name: string): ToolKind {
  const normalized = name.toLowerCase()
  if (normalized.startsWith('mcp__')) return 'other'
  if (/^(read|view)|read_file|list_file/.test(normalized)) return 'read'
  if (/^(write|edit|apply_patch)|write_file/.test(normalized)) return 'edit'
  if (/delete|remove|unlink/.test(normalized)) return 'delete'
  if (/move|rename/.test(normalized)) return 'move'
  if (/search|find|grep|glob|(^|_)rg($|_)/.test(normalized)) return 'search'
  if (/bash|shell|terminal|exec|command/.test(normalized)) return 'execute'
  if (/fetch|http|get_url/.test(normalized)) return 'fetch'
  if (/think|plan|todo/.test(normalized)) return 'think'
  return 'other'
}

/** Map the registered todo projection; null clears the previous turn's plan. */
export function planUpdate(todos: Readonly<SessionProjectionViewValues['todos']>): SessionUpdate {
  return {
    sessionUpdate: 'plan',
    entries: (todos ?? []).map((todo) => ({ ...todo, priority: 'medium' })),
  }
}

/** Forward an accepted Harness title without manufacturing one for empty sessions. */
export function titleUpdate(
  title: SessionProjectionViewValues['title'] | undefined,
): SessionUpdate | undefined {
  return title == null ? undefined : { sessionUpdate: 'session_info_update', title }
}
