import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

/**
 * Accepted Node.js signal names.
 */
export type Signals = NodeJS.Signals

/**
 * Signal values accepted by `kill()`.
 */
export type KillSignal = number | Signals

/**
 * A line matcher used by `match()` and `waitFor()`.
 *
 * String patterns use substring matching. `RegExp` patterns are executed
 * against the full observed line.
 */
export type MatchPattern = string | RegExp

/**
 * The output streams that can participate in line matching.
 */
export type MatchStream = 'stdout' | 'stderr' | 'both'

/**
 * Configuration for a single supervised subprocess.
 */
export interface ProcessConfig {
  /**
   * Stable identifier used in prefixed output and emitted match events.
   *
   * Defaults to the trailing `/[-\w]+$/` match from `command`.
   */
  name?: string

  /**
   * Executable or shell-free command name passed to `spawn()`.
   */
  command: string

  /**
   * Positional arguments passed to the child process.
   */
  args?: string[]

  /**
   * Working directory for the child process.
   */
  cwd?: string

  /**
   * Environment variables for the child process.
   */
  env?: Record<string, string | undefined>

  /**
   * Whether to spawn the child in a detached process group/session.
   *
   * This is passed through to Node.js `spawn()` unchanged.
   */
  detached?: boolean

  /**
   * Human-facing label used in prefixed output.
   *
   * Defaults to `name`.
   */
  label?: string

  /**
   * RGB color for this process's `stdout` prefix.
   *
   * When omitted, `procband` assigns the next color from its default palette.
   * The reserved `stderr` red cannot be used here.
   */
  color?: RgbColor

  /**
   * Optional extra sink for raw child `stderr` bytes.
   *
   * This is additive. It does not replace the normal prefixed writes to
   * `process.stderr`.
   */
  stderr?: Writable

  /**
   * Child stdin behavior.
   *
   * Defaults to `false`, which connects the child stdin to the null device.
   * Use `true` to expose a writable `proc.stdin`, or pass a readable stream to
   * pipe bytes into the child automatically.
   */
  stdin?: boolean | Readable

  /**
   * Signal to send when the parent process is shutting down.
   *
   * When provided, `procband` uses this signal for parent-driven cleanup on
   * `SIGINT`, `SIGTERM`, and `exit` instead of mirroring the parent signal or
   * relying on the platform default. This only affects parent-driven cleanup;
   * `proc.kill()` still uses its own explicit signal argument.
   */
  parentExitSignal?: KillSignal

  /**
   * Automatic restart behavior for terminal child exits.
   *
   * Use `true` for the built-in defaults or provide an explicit policy.
   */
  restart?: boolean | RestartPolicy
}

/**
 * A 24-bit RGB color tuple.
 */
export type RgbColor = readonly [red: number, green: number, blue: number]

/**
 * Controls whether and how a supervised process restarts after exit.
 */
export interface RestartPolicy {
  /**
   * Which exit outcomes trigger a restart.
   *
   * Defaults to `"on-failure"`.
   */
  when?: 'on-failure' | 'on-exit'

  /**
   * Delay before spawning the next attempt.
   *
   * Defaults to `1000`.
   */
  delayMs?: number

  /**
   * Maximum failed exits allowed inside `windowMs` before restart is
   * suppressed.
   *
   * Defaults to `3`.
   */
  maxFailures?: number

  /**
   * Rolling time window used for failed-exit suppression.
   *
   * Defaults to `30000`.
   */
  windowMs?: number
}

/**
 * Common options for line-matching APIs.
 */
export interface MatchOptions {
  /**
   * Which output stream to inspect.
   *
   * Defaults to `"both"`.
   */
  stream?: MatchStream
}

/**
 * Options for `waitFor()`.
 */
export interface WaitForOptions extends MatchOptions {
  /**
   * Maximum time to wait for a future match before rejecting.
   */
  timeoutMs?: number
}

/**
 * A matched output line observed from a supervised process.
 */
export interface MatchEvent {
  /**
   * The `ProcessConfig.name` associated with the process.
   */
  process: string

  /**
   * Which child output stream produced the line.
   */
  stream: 'stdout' | 'stderr'

  /**
   * The matched line without its trailing newline.
   */
  line: string

  /**
   * The `RegExp.exec()` result for regex patterns, or `null` for string
   * patterns.
   */
  match: RegExpExecArray | null

  /**
   * The wall-clock timestamp, in milliseconds since the Unix epoch, when the
   * line was emitted to subscribers.
   */
  timestamp: number
}

/**
 * Callback invoked for each future matching line.
 */
export type MatchCallback = (event: MatchEvent) => void

/**
 * Stops a callback subscription created by `match()`.
 */
export type Unsubscribe = () => void

/**
 * Final state for a supervised process after all restart attempts are done.
 */
export interface ProcessResult {
  /**
   * The `ProcessConfig.name` for the completed process.
   */
  name: string

  /**
   * Final child exit code, or `null` when the process exited by signal.
   */
  code: number | null

  /**
   * Shell-style exit status for the final process outcome.
   *
   * This is equal to `code` for normal exits, or `128 + signalNumber` when the
   * process exited by signal.
   */
  exitCode: number

  /**
   * Final terminating signal, or `null` when the process exited normally.
   */
  signal: Signals | null

  /**
   * Number of restart attempts that were started.
   */
  restarts: number

  /**
   * Whether restart was disabled by the failure-suppression guard.
   */
  restartSuppressed: boolean
}

/**
 * A supervised child-process handle.
 *
 * `ProcbandProcess` behaves like the current active `ChildProcess`, while also
 * exposing matching, terminal shutdown, and final-result helpers. The wrapper
 * is thenable, so `await proc` is equivalent to `await proc.wait()`.
 */
export interface ProcbandProcess
  extends ChildProcess,
    PromiseLike<ProcessResult> {
  /**
   * Subscribe to future matching lines from this process.
   *
   * Matching is line-based and forward-only. One subscription does not consume
   * events from another. If `onMatch` throws, only that subscription is
   * removed.
   *
   * @param pattern The string or regular expression to match against each
   * future line.
   * @param onMatch Invoked for every future matching line.
   * @param options Optional stream filter.
   * @returns An idempotent function that unsubscribes the callback.
   */
  match(
    pattern: MatchPattern,
    onMatch: MatchCallback,
    options?: MatchOptions,
  ): Unsubscribe

  /**
   * Wait for the first future matching line from this process.
   *
   * @param pattern The string or regular expression to match against each
   * future line.
   * @param options Optional stream filter and timeout.
   * @returns The first future matching event.
   * @throws When `timeoutMs` elapses before a match is observed.
   * @throws When the process becomes terminal before a match is observed.
   */
  waitFor(
    pattern: MatchPattern,
    options?: WaitForOptions,
  ): Promise<MatchEvent>

  /**
   * Wait for the process to become terminal with no further restart pending.
   *
   * Unlike many process helpers, this resolves for both success and failure.
   * Inspect the returned `ProcessResult` instead of relying on promise
   * rejection for non-zero exits.
   */
  wait(): Promise<ProcessResult>

  /**
   * Disable future restarts and terminate the active process tree.
   *
   * For supervised processes, `kill()` targets the current child process and
   * any descendants it spawned instead of only the direct child.
   * `kill(0)` preserves the normal `ChildProcess` existence-check behavior.
   */
  kill(signal?: KillSignal): boolean
}
