/** Workspace-relative path resolution shared by export and full-text saving. */

import { isAbsolute, resolve } from 'node:path'

/**
 * Resolve a user-supplied path against the session working directory.
 * Absolute paths pass through unchanged; relative paths fall back to the
 * process cwd when no working-directory service or agent is available.
 *
 * @param {object} ctx Cordis context
 * @param {object} exec tool execution context
 * @param {string} requested path from the tool arguments
 * @returns {Promise<string>} absolute path
 */
export async function resolveWorkspacePath(ctx, exec, requested) {
  if (isAbsolute(requested)) return requested
  let base = process.cwd()
  try {
    const workingDirectory = ctx.get?.('workingDirectory')
    if (workingDirectory && exec?.agent) {
      base = await workingDirectory.ensure(exec.agent, exec.signal)
    }
  } catch {
    // No working-directory service, or no agent scope: keep process.cwd().
  }
  return resolve(base, requested)
}
