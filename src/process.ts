import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { constants } from 'node:os'
import process from 'node:process'
import type { Readable, Writable } from 'node:stream'
import {
  resolveProcessColor,
  stderrColor,
  validateProcessColor,
  writePrefixedLine,
} from './colors.js'
import { MatchRegistry } from './matching.js'
import { RestartController } from './restart.js'
import {
  killTreeBestEffort,
  registerCleanupTarget,
  stopChildTree,
  unregisterCleanupTarget,
  type CleanupTarget,
} from './shutdown.js'
import type {
  KillSignal,
  MatchOptions,
  MatchPattern,
  ProcbandProcess,
  ProcessConfig,
  ProcessResult,
  RgbColor,
  Signals,
  StopOptions,
  WaitForOptions,
} from './types.js'

type Attempt = {
  readonly child: SupervisedChild
  readonly generation: number
  readonly close: Promise<{ code: number | null; signal: Signals | null }>
  readonly settleClose: (result: { code: number | null; signal: Signals | null }) => void
  stdout: LineBuffer
  stderr: LineBuffer
  closed: boolean
  stdinCleanup: (() => void) | null
}

type LineBuffer = {
  text: string
  flushed: boolean
}

type SupervisedChild = ChildProcessByStdio<Writable | null, Readable, Readable>

/**
 * Start supervising a single subprocess.
 *
 * The returned `ProcbandProcess` starts immediately, prefixes child output,
 * exposes line-based matching helpers, and resolves when the process reaches a
 * terminal state with no further restart pending.
 *
 * @param config The subprocess configuration to supervise.
 * @returns A `ChildProcess`-compatible wrapper with procband-specific helpers.
 * @throws When `config` is invalid, such as a missing `command`, a `command`
 * that does not produce a fallback `name`, or an invalid reserved color.
 * @example
 * ```ts
 * import process from 'node:process'
 * import { supervise } from 'procband'
 *
 * const proc = supervise({
 *   name: 'server',
 *   command: process.execPath,
 *   args: ['-e', 'console.log("ready")'],
 * })
 *
 * await proc.waitFor('ready')
 * const result = await proc
 * console.log(result)
 * ```
 */
export function supervise(config: ProcessConfig): ProcbandProcess {
  return new ProcbandProcessImpl(config) as unknown as ProcbandProcess
}

class ProcbandProcessImpl
  extends EventEmitter
  implements PromiseLike<ProcessResult>, CleanupTarget
{
  readonly config: ProcessConfig
  readonly name: string
  readonly label: string
  readonly color: RgbColor

  private readonly matches: MatchRegistry
  private readonly restart: RestartController
  private readonly finalPromise: Promise<ProcessResult>
  private finalResolve!: (result: ProcessResult) => void

  private attempt: Attempt | null = null
  private generation = 0
  private stderrSink: Writable | null
  private stderrSinkActive = true
  private stderrSinkCleanup: (() => void) | null = null
  private stopPromise: Promise<void> | null = null
  private shutdownRequested = false
  private restartDisabled = false
  private finalized = false
  private lastResult: ProcessResult | null = null
  private terminalResultObserved = false

  constructor(config: ProcessConfig) {
    super()

    const name = validateProcessConfig(config)

    this.config = config
    this.name = name
    this.label = config.label ?? name
    this.color = resolveProcessColor(config.color)
    this.matches = new MatchRegistry(this.name)
    this.restart = new RestartController(config.restart)
    this.stderrSink = config.stderr ?? null
    this.finalPromise = new Promise((resolve) => {
      this.finalResolve = resolve
    })

    this.bindStderrSink()
    this.spawnAttempt()
    registerCleanupTarget(this)
    liveProcesses.add(this)
  }

  get pid() {
    return this.currentChild?.pid
  }

  get stdin() {
    return this.currentChild?.stdin ?? null
  }

  get stdout() {
    return this.currentChild?.stdout ?? null
  }

  get stderr() {
    return this.currentChild?.stderr ?? null
  }

  get stdio() {
    return this.currentChild?.stdio ?? [null, null, null]
  }

  get killed() {
    return this.currentChild?.killed ?? false
  }

  get exitCode() {
    return this.currentChild?.exitCode ?? this.lastResult?.code ?? null
  }

  get signalCode() {
    return this.currentChild?.signalCode ?? this.lastResult?.signal ?? null
  }

  get connected() {
    return this.currentChild?.connected ?? false
  }

  get spawnargs() {
    return this.currentChild?.spawnargs ?? []
  }

  get spawnfile() {
    return this.currentChild?.spawnfile ?? this.config.command
  }

  get currentChild() {
    return this.attempt?.child ?? null
  }

  match(
    pattern: MatchPattern,
    onMatch: Parameters<ProcbandProcess['match']>[1],
    options?: MatchOptions,
  ) {
    return this.matches.match(pattern, onMatch, options)
  }

  waitFor(pattern: MatchPattern, options?: WaitForOptions) {
    return this.matches.waitFor(pattern, options)
  }

  wait(): Promise<ProcessResult> {
    this.markTerminalResultObserved()
    return this.finalPromise
  }

  then<TResult1 = ProcessResult, TResult2 = never>(
    onfulfilled?: ((value: ProcessResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    this.markTerminalResultObserved()
    return this.finalPromise.then(onfulfilled, onrejected)
  }

  kill(signal?: KillSignal) {
    const child = this.currentChild
    if (!child) {
      return false
    }
    return child.kill(signal)
  }

  ref() {
    this.currentChild?.ref()
    return this
  }

  unref() {
    this.currentChild?.unref()
    return this
  }

  disconnect() {
    this.currentChild?.disconnect()
  }

  async stop(options?: StopOptions): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise
    }

    this.shutdownRequested = true
    this.restartDisabled = true
    this.restart.cancelDelay()

    this.stopPromise = this.stopActiveTree(
      options?.signal ?? 'SIGTERM',
      options?.killAfterMs ?? 5000,
    )

    return this.stopPromise
  }

  cleanupFromExit() {
    this.shutdownRequested = true
    this.restartDisabled = true
    this.restart.cancelDelay()

    const child = this.currentChild
    if (child) {
      killTreeBestEffort(child, this.getParentCleanupSignal())
    }
  }

  async cleanupFromSignal(signal: Signals) {
    this.shutdownRequested = true
    this.restartDisabled = true
    this.restart.cancelDelay()
    await this.stopActiveTree(this.getParentCleanupSignal(signal), 1000)
  }

  private async stopActiveTree(signal: KillSignal, killAfterMs: number) {
    const attempt = this.attempt
    if (!attempt || attempt.closed) {
      await this.finalPromise
      return
    }

    await stopChildTree(attempt.child, attempt.close, () => attempt.closed, signal, killAfterMs)
  }

  private getParentCleanupSignal(): KillSignal | undefined
  private getParentCleanupSignal(fallback: KillSignal): KillSignal
  private getParentCleanupSignal(fallback?: KillSignal) {
    return this.config.parentExitSignal ?? fallback
  }

  private spawnAttempt() {
    this.generation += 1

    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      detached: this.config.detached,
      env: this.config.env,
      stdio: [this.config.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    }) as SupervisedChild

    let settleClose!: Attempt['settleClose']
    const attempt: Attempt = {
      child,
      generation: this.generation,
      close: new Promise((resolve) => {
        settleClose = resolve
      }),
      settleClose,
      stdout: { text: '', flushed: false },
      stderr: { text: '', flushed: false },
      closed: false,
      stdinCleanup: null,
    }

    this.attempt = attempt
    this.attachAttempt(attempt)
  }

  private attachAttempt(attempt: Attempt) {
    const { child } = attempt
    attempt.stdinCleanup = this.bindAttemptStdin(attempt)

    child.on('spawn', () => {
      if (this.attempt === attempt) {
        this.emit('spawn')
      }
    })

    child.on('error', (error: Error) => {
      if (this.attempt === attempt) {
        this.emit('error', error)
      }
    })

    child.on('exit', (code: number | null, signal: Signals | null) => {
      if (this.attempt === attempt) {
        this.emit('exit', code, signal)
      }
    })

    child.on('close', (code: number | null, signal: Signals | null) => {
      if (this.attempt !== attempt) {
        return
      }

      attempt.closed = true
      attempt.stdinCleanup?.()
      attempt.stdinCleanup = null
      this.flushLineBuffer(attempt, 'stdout')
      this.flushLineBuffer(attempt, 'stderr')
      attempt.settleClose({ code, signal })
      this.emit('close', code, signal)
      void this.handleAttemptClose(code, signal)
    })

    child.stdout.on('data', (chunk: Buffer) => {
      if (this.attempt === attempt) {
        this.handleChunk(attempt, 'stdout', chunk)
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      if (this.attempt !== attempt) {
        return
      }

      this.writeStderrSink(chunk)
      this.handleChunk(attempt, 'stderr', chunk)
    })

    child.stdout.on('end', () => {
      if (this.attempt === attempt) {
        this.flushLineBuffer(attempt, 'stdout')
      }
    })

    child.stderr.on('end', () => {
      if (this.attempt === attempt) {
        this.flushLineBuffer(attempt, 'stderr')
      }
    })
  }

  private handleChunk(attempt: Attempt, stream: 'stdout' | 'stderr', chunk: Buffer) {
    const buffer = attempt[stream]
    let text = buffer.text + chunk.toString('utf8')
    let newlineIndex = text.indexOf('\n')

    while (newlineIndex >= 0) {
      const rawLine = text.slice(0, newlineIndex)
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      this.handleLine(stream, line, true)
      text = text.slice(newlineIndex + 1)
      newlineIndex = text.indexOf('\n')
    }

    buffer.text = text
  }

  private handleLine(stream: 'stdout' | 'stderr', line: string, appendNewline: boolean) {
    writePrefixedLine(
      stream === 'stdout' ? process.stdout : process.stderr,
      this.label,
      stream === 'stdout' ? this.color : stderrColor,
      line,
      appendNewline,
    )

    this.matches.emit(stream, line)
  }

  private async handleAttemptClose(code: number | null, signal: Signals | null) {
    if (this.restart.shouldRestart(code, signal, this.restartDisabled, this.finalized)) {
      if (!this.restart.prepareRestart(code, signal)) {
        this.finalize(this.createResult(code, signal))
        return
      }

      const completedDelay = await this.restart.waitForDelay()
      if (!completedDelay || this.finalized || this.restartDisabled) {
        this.finalize(this.createResult(code, signal))
        return
      }

      this.spawnAttempt()
      return
    }

    this.finalize(this.createResult(code, signal))
  }

  private createResult(code: number | null, signal: Signals | null): ProcessResult {
    return {
      name: this.name,
      code,
      exitCode: getResultExitCode(code, signal),
      signal,
      restarts: this.restart.restarts,
      restartSuppressed: this.restart.restartSuppressed,
    }
  }

  private finalize(result: ProcessResult) {
    if (this.finalized) {
      return
    }

    this.finalized = true
    this.restart.cancelDelay()
    this.lastResult = result
    liveProcesses.delete(this)
    if (liveProcesses.size === 0) {
      propagatedFailure = false
    }
    if (this.shouldPropagateFailure(result)) {
      propagateFailure(result.exitCode)
    }
    this.matches.close(
      new Error(`Process "${this.name}" exited before a matching line was observed`),
    )
    this.unbindStderrSink()
    unregisterCleanupTarget(this)
    this.finalResolve(result)
  }

  private markTerminalResultObserved() {
    this.terminalResultObserved = true
  }

  private shouldPropagateFailure(result: ProcessResult) {
    return result.exitCode !== 0 && !this.shutdownRequested && !this.terminalResultObserved
  }

  private bindStderrSink() {
    const sink = this.stderrSink
    if (!sink || typeof sink.on !== 'function') {
      return
    }

    const disable = () => {
      this.stderrSinkActive = false
    }

    sink.on('error', disable)
    sink.on('close', disable)
    this.stderrSinkCleanup = () => {
      sink.off('error', disable)
      sink.off('close', disable)
    }
  }

  private unbindStderrSink() {
    this.stderrSinkCleanup?.()
    this.stderrSinkCleanup = null
  }

  private writeStderrSink(chunk: Buffer) {
    const sink = this.stderrSink
    if (!sink || !this.stderrSinkActive) {
      return
    }

    try {
      if ('destroyed' in sink && sink.destroyed) {
        this.stderrSinkActive = false
        return
      }

      sink.write(chunk)
    } catch {
      this.stderrSinkActive = false
    }
  }

  private flushLineBuffer(attempt: Attempt, stream: 'stdout' | 'stderr') {
    const buffer = attempt[stream]
    if (buffer.flushed || buffer.text.length === 0) {
      buffer.flushed = true
      return
    }

    buffer.flushed = true
    const line = buffer.text.endsWith('\r') ? buffer.text.slice(0, -1) : buffer.text
    buffer.text = ''
    this.handleLine(stream, line, false)
  }

  private bindAttemptStdin(attempt: Attempt) {
    const source = this.config.stdin
    const destination = attempt.child.stdin

    if (!destination || typeof source !== 'object') {
      return null
    }

    source.pipe(destination)
    return () => {
      source.unpipe(destination)
    }
  }
}

const liveProcesses = new Set<ProcbandProcessImpl>()
let propagatedFailure = false

function validateProcessConfig(config: ProcessConfig) {
  if (!config.command) {
    throw new Error('ProcessConfig.command is required')
  }

  validateProcessColor(config.color)

  const name = config.name || inferProcessName(config.command)
  if (!name) {
    throw new Error('ProcessConfig.name is required when command does not match /[-\\w]+$/')
  }

  return name
}

function inferProcessName(command: string) {
  return command.match(/[-\w]+$/)?.[0]
}

function getResultExitCode(code: number | null, signal: Signals | null) {
  if (code != null) {
    return code
  }

  if (signal) {
    return 128 + (constants.signals[signal] ?? 0)
  }

  return 1
}

function propagateFailure(exitCode: number) {
  if (propagatedFailure) {
    return
  }

  propagatedFailure = true

  if (process.exitCode == null || process.exitCode === 0) {
    process.exitCode = exitCode
  }

  for (const proc of liveProcesses) {
    void proc.stop().catch(() => {})
  }
}
