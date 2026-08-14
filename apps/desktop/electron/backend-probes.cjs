/**
 * backend-probes.cjs
 *
 * Cheap "does this candidate backend actually work" checks used by
 * resolveFanBackend (main.cjs). The resolver walks a ladder of
 * candidates -- bootstrap marker, `fan` on PATH, system Python with
 * fan_cli installed -- and historically returned the first candidate
 * whose binary existed on disk. That assumption breaks when a user has
 * a pre-installed Python 3.11-3.13 (so findSystemPython() returns a
 * path) but no fan_cli in its site-packages: the resolver hands back
 * a backend the spawn step can't actually run, and the user gets a
 * dead-on-arrival "ModuleNotFoundError: No module named 'fan_cli'"
 * instead of the first-launch installer.
 *
 * These probes give the resolver a way to verify a candidate before
 * trusting it. Failure (non-zero exit, exception, timeout) means "skip
 * this rung, try the next one"; success means "spawn this for real."
 * Falling off the bottom of the ladder lands on the bootstrap-needed
 * sentinel, which is exactly what we want when nothing pre-existing
 * actually works.
 *
 * Both probes are deliberately fast and forgiving:
 *   - 5s timeout (a hung interpreter beats forever, but we still give
 *     slow disks / cold caches room to breathe)
 *   - stdio ignored (we only care about exit code; stdout/stderr are
 *     not surfaced to the user, just to recentFanLog for forensics
 *     via the caller's catch block if it chooses)
 *   - any throw -> false (never propagate -- resolver wants a boolean)
 *
 * Kept in a standalone cjs module so it can be unit-tested with
 * `node --test` without dragging in the electron runtime (same pattern
 * as bootstrap-platform.cjs and hardening.cjs).
 */

const { execFileSync } = require('node:child_process')

const PROBE_TIMEOUT_MS = 5000
const BACKEND_IMPORT_PROBE = [
  'import certifi',
  'import fastapi',
  'import fan_cli.main',
  'import fan_cli.runtime_provider',
  'import jiter',
  'import uvicorn'
].join('; ')

/**
 * Return true iff `python -c "import fan_cli"` exits 0.
 *
 * Used to gate the "fallback to system Python with fan_cli installed"
 * rung of resolveFanBackend. Without this, a system Python 3.11-3.13
 * registered in PEP 514 makes findSystemPython() succeed regardless of
 * whether fan_cli has actually been pip-installed into its
 * site-packages -- and the resolver returns a backend that immediately
 * dies on spawn.
 *
 * @param {string} pythonPath - Absolute path to a python.exe / python.
 * @returns {boolean}
 */
function canImportFanCli(pythonPath, opts = {}) {
  if (!pythonPath) return false
  try {
    execFileSync(pythonPath, ['-P', '-c', 'import fan_cli'], {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true
    })
    return true
  } catch {
    return false
  }
}

/**
 * Return true iff the interpreter can import the modules required before the
 * desktop backend can accept chat sessions.
 *
 * This catches stale or half-synced venvs early. A plain `import fan_cli`
 * can succeed while transitive runtime deps such as certifi/jiter or source
 * modules such as fan_cli.runtime_provider are missing; in that state the
 * dashboard may boot, but the first chat session fails later with an opaque
 * "agent init failed" message.
 *
 * @param {string} pythonPath - Absolute path to a python.exe / python.
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env] - Extra env such as PYTHONPATH.
 * @returns {boolean}
 */
function canStartFanBackend(pythonPath, opts = {}) {
  if (!pythonPath) return false
  try {
    execFileSync(pythonPath, ['-P', '-c', BACKEND_IMPORT_PROBE], {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true
    })
    return true
  } catch (error) {
    // Node reports spawnSync timeouts as ETIMEDOUT (older versions: SIGTERM
    // kill with no exit status). A cold first launch (AV or cold FS cache) can
    // push a healthy interpreter past the 5s budget, so
    // timeout means "unproven", not "broken": report probe-pass and let the
    // spawn + 45s ready-wait be the real judge instead of condemning the
    // install to a bogus re-download verdict.
    const timedOut = error?.code === 'ETIMEDOUT' || (error?.signal === 'SIGTERM' && error?.status == null)
    opts.onFailure?.({
      timedOut,
      stderr: error?.stderr ? String(error.stderr).slice(0, 2000) : '',
      message: error?.message || String(error)
    })
    // timeout→pass is only safe on a TERMINAL rung (the bundled backend):
    // there the alternative to proceeding is a bogus "reinstall" verdict.
    // Rungs with lower candidates below them must keep timeout→false so the
    // resolver ladder can fall through instead of selecting a hung
    // interpreter and eating the 45s ready-wait.
    return timedOut && opts.allowTimeoutPass === true
  }
}

/**
 * Return true iff `<fanCommand> --version` exits 0.
 *
 * Used to gate the "existing `fan` on PATH" rung. Without this, a
 * stale fan.cmd shim left behind by an uninstalled pip install (or
 * a half-built venv whose `fan` entry-point points at a deleted
 * Python) survives findOnPath() and gets selected as the backend.
 *
 * We intentionally avoid invoking the command with the dashboard args
 * here -- `--version` is the cheapest "is this binary alive" smoke
 * test that every fan_cli entry-point has supported since 0.1.
 *
 * @param {string} fanCommand - Resolved absolute path to a fan
 *   executable (or an interpreter+script wrapper).
 * @param {object} [opts]
 * @param {boolean} [opts.shell] - Whether to run through a shell. For
 *   .cmd/.bat shims on Windows execFileSync needs shell:true to find
 *   the cmd interpreter; mirrors the same flag isCommandScript() drives
 *   in resolveFanBackend.
 * @returns {boolean}
 */
function verifyFanCli(fanCommand, opts = {}) {
  if (!fanCommand) return false
  try {
    execFileSync(fanCommand, ['--version'], {
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
      shell: Boolean(opts.shell),
      windowsHide: true
    })
    return true
  } catch {
    return false
  }
}

module.exports = {
  canStartFanBackend,
  canImportFanCli,
  verifyFanCli
}
