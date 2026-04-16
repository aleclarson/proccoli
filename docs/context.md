# Overview

`procband` supervises one subprocess per `supervise()` call.

The returned `ProcbandProcess` is both:

- a `ChildProcess`-compatible handle for the current active child attempt
- a thenable wrapper that resolves to a `ProcessResult` when supervision is done

Supervision adds five behaviors on top of raw `spawn()`:

- prefixed `stdout` and `stderr`
- line-based matching for future output
- optional restart policy with failure suppression
- tree-aware shutdown for the child and its descendants
- parent-exit propagation for unobserved terminal failures

# When to Use

- You are writing project-specific TypeScript scripts, not a CLI.
- You need to wait for a subprocess to print a "ready" line.
- You want readable prefixed logs from multiple long-lived child processes.
- You need one shutdown API that kills descendant processes too.
- You want automatic restart with a small built-in guard against tight failure
  loops.

# When Not to Use

- You need a standalone process manager or service supervisor.
- You need buffered log history or replay for late subscribers.
- You need shell pipelines, shell parsing, or a command-line tool.
- You want one API that supervises many processes at once. `procband` keeps the
  unit of supervision to one process per call.

# Core Abstractions

- `ProcessConfig`
  Declares one supervised subprocess plus its label, color, restart policy,
  optional stdin behavior, optional detached spawn mode, optional
  parent-exit signal override, and optional raw `stderr` tee.
- `ProcbandProcess`
  The live wrapper returned by `supervise()`. It is a `ChildProcess`-compatible
  handle, a matching surface, a shutdown surface, and a thenable final result.
- `MatchEvent`
  A future matched line from `stdout` or `stderr`.
- `RestartPolicy`
  Rules for restart timing and failed-exit suppression.

# Data Flow / Lifecycle

1. `supervise(config)` spawns the first child process immediately.
2. Child `stdout` and `stderr` are read as text and split into lines.
3. Each line is prefixed and written to the parent `process.stdout` or
   `process.stderr`.
4. `stderr` can also be tee'd as raw bytes to `ProcessConfig.stderr`.
5. `stdin` is disconnected by default. Set `ProcessConfig.stdin` to `true` for
   a writable child stdin, or pass a readable stream to pipe input into the
   child automatically.
6. Future matching lines are delivered through `match()` callbacks or
   `waitFor()`.
7. When a child exits, `procband` either finalizes or starts a new attempt,
   depending on the restart policy.
8. A terminal failed exit that nobody observed through `await proc` or
   `proc.wait()` sets `process.exitCode` and begins
   stopping any other live `procband` processes in the same parent script.
9. `await proc` or `await proc.wait()` resolves only after the process is
   terminal and no further restart will happen.

# Common Tasks -> Recommended APIs

- Wait for one readiness line:
  `proc.waitFor('ready')`
- React to repeated matching output:
  `proc.match(pattern, callback, options)`
- Stop the process and its descendants:
  `proc.stop()`
- Inspect final exit state:
  `await proc` or `await proc.wait()`
- Take ownership of a process failure:
  `await proc` or `await proc.wait()`
- Let an unobserved terminal failure fail the parent script:
  Do not call `wait()` or await the thenable result
- Capture raw child `stderr` in a file or custom stream:
  `ProcessConfig.stderr`
- Write to child stdin manually:
  `stdin: true`, then `proc.stdin?.write(...)`
- Pipe a custom input stream into the child:
  `stdin: readable`
- Retry failed exits with sane defaults:
  `restart: true`
- Use explicit retry rules:
  `restart: { when, delayMs, maxFailures, windowMs }`
- Force a specific signal during parent shutdown:
  `parentExitSignal: 'SIGHUP'`

# Recommended Patterns

- Use `proc.stop()` for deliberate shutdown initiated by your own script.
- Reserve `parentExitSignal` for children that expect a specific signal from
  their supervisor during parent-driven cleanup.
- Await `proc` or call `proc.wait()` when your script intends to own failure
  handling instead of inheriting procband's default parent-exit propagation.

# Patterns to Avoid

- Do not treat `parentExitSignal` as a replacement for `StopOptions.signal`.
  The former only changes parent-driven cleanup; the latter controls
  explicit `proc.stop()` calls.
- Do not rely on `kill()` for full shutdown when descendants may still be
  running. `kill()` only targets the current direct child.
- Do not expect historical log replay from `match()` or `waitFor()`. Matching
  is future-only by design.

# Invariants and Constraints

- Matching is line-based and future-only.
- String patterns use substring matching.
- RegExp patterns run against the full observed line.
- `match()` subscriptions do not interfere with each other.
- `waitFor()` rejects if the process becomes terminal before a future match is
  observed.
- `await proc` resolves for both successful and failed exits. Inspect the
  returned `ProcessResult`.
- `ProcessResult.exitCode` exposes the shell-style exit status for the final
  outcome, including signal exits.
- Calling `proc.wait()` or awaiting the thenable process marks its terminal
  result as observed and suppresses default parent-exit propagation.
- An unobserved terminal failure sets `process.exitCode` to the first failing
  process's `ProcessResult.exitCode` and starts stopping other live `procband`
  processes in the same parent script.
- The wrapper survives restarts, but inherited `pid`, `stdin`, `stdout`,
  `stderr`, and related `ChildProcess` fields always refer to the current active
  child attempt. `stdin` is `null` unless `ProcessConfig.stdin` is enabled.
- `kill()` only signals the current direct child. `stop()` disables restart and
  kills the full process tree.
- Parent cleanup installs both `SIGINT` and `SIGTERM` handlers while any live
  supervised process exists. Set `ProcessConfig.parentExitSignal` to override
  which signal is sent to the child tree during parent-driven cleanup. This
  does not change the signal used by explicit `proc.stop()` calls.
- `stderr` prefixes always use the reserved red, even when a custom process
  color is configured.
- `ProcessConfig.name` is optional. When omitted, it falls back to the
  trailing `/[-\w]+$/` match from `command`.

# Error Model

- `supervise()` throws synchronously for invalid config such as missing
  `command`, a `command` that does not produce a fallback `name`, or an
  invalid reserved color.
- `waitFor()` rejects on timeout or terminal exit before a future match.
- A thrown `match()` callback only unsubscribes that callback.
- Errors from `ProcessConfig.stderr` stop teeing to that sink but do not stop
  supervision.
- Unobserved terminal failures do not reject promises. They set the parent
  `process.exitCode` and start stopping sibling `procband` processes.
- `stop()` may reject if tree-kill fails with a non-`ESRCH` error.

# Terminology

- Supervised process:
  A `ProcbandProcess` wrapper plus its current child attempt.
- Child attempt:
  One concrete spawned process instance inside a supervision run.
- Terminal:
  No child is running and no restart will be started.
- Restart suppression:
  Automatic disabling of further restarts after too many failed exits inside the
  configured window.
- Match:
  A future observed output line that satisfies a string or regex pattern.

# Non-Goals

- A standalone CLI
- Historical log replay
- Multi-process orchestration in one top-level API
- Shell command parsing
- Full service-management features such as persistence, cron scheduling, or host
  restarts
