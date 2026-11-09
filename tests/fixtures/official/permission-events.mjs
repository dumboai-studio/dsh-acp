/** Exercise permission changes made by another Harness integration. */
import { readFile, watch } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const name = 'fixture-permission-events'
export const inject = ['agents', 'permissionPresets', 'approval']
export function apply(ctx) {
  ctx.effect(() => {
    const abort = new AbortController()
    const root = dirname(process.env.DSH_ACP_TEST_FILE)
    let lastRequest
    let removeAuto
    const run = (async () => {
      try {
        for await (const { filename } of watch(root, { signal: abort.signal })) {
          if (filename !== 'permission-event.json') continue
          const { requestId, sessionId, action } = JSON.parse(
            await readFile(join(root, filename), 'utf8'),
          )
          abort.signal.throwIfAborted()
          if (requestId === lastRequest) continue
          lastRequest = requestId
          const agent = ctx.agents.get(sessionId)
          if (action === 'preset') ctx.permissionPresets.set(agent.session, 'workspace-write')
          else if (action === 'custom') ctx.approval.setPolicy(agent, 'never')
          else if (action === 'add-auto') removeAuto = ctx.permissionPresets.registerAuto(() => {})
          else if (action === 'remove-auto') await removeAuto()
          else throw new Error(`unknown fixture action: ${action}`)
        }
      } catch (error) {
        if (!abort.signal.aborted) throw error
      }
    })()
    void run.catch((error) => ctx.logger.error(error))
    return async () => {
      abort.abort()
      await run
    }
  })
}
