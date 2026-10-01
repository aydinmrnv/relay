#!/usr/bin/env python3
"""Runs a command on a pseudo-terminal and types at it.

Relay's live display reads single keys, which puts the terminal in raw mode —
and what Ctrl-C does in raw mode can only be observed on a real terminal. A
pipe is not one: stdin is not a TTY there, raw mode is never entered, and the
bug this exists to catch (Ctrl-C arriving as a byte nobody reads) cannot occur.
Node has no pty of its own, so the test borrows Python's.

    terminal.py '<json spec>'

    spec    { "argv": [...], "cwd": "...", "env": { "NAME": "value" | null },
              "steps": [{ "wait": "text", "send": "\\u0003", "delay": 0.2 },
                        { "wait": "text", "remove": "/path/to/a/file" },
                        { "wait": "text", "signal": "TERM" }],
              "timeout": 30, "columns": 100, "rows": 40 }
    prints  { "status": 130 | null, "signal": 2 | null, "timedOut": false,
              "stepsDone": 2, "output": "..." }

Each step waits for its text to appear in what the command has printed since
the previous step, then types `send`. A command that exits before a step's text
appears simply ends the script: `stepsDone` says how far it got.

A step with `remove` deletes that file instead of typing. It is how a test
pulls something out from under a command at a moment only the terminal can
name — "once the display is up" — which no timer in the test could hit. A
step with `signal` sends the command that signal, by name without the `SIG`,
which is what a supervisor or a closing terminal does and a keyboard cannot.
"""

import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def main() -> None:
    spec = json.loads(sys.argv[1])
    argv = spec["argv"]
    steps = spec.get("steps", [])
    deadline = time.monotonic() + float(spec.get("timeout", 30))

    env = dict(os.environ)
    for name, value in spec.get("env", {}).items():
        if value is None:
            env.pop(name, None)
        else:
            env[name] = value

    pid, fd = pty.fork()
    if pid == 0:
        # The size is set before the command starts, so its first frame is laid
        # out for the terminal it will be read on rather than for 0 columns.
        size = struct.pack("HHHH", int(spec.get("rows", 40)), int(spec.get("columns", 100)), 0, 0)
        fcntl.ioctl(0, termios.TIOCSWINSZ, size)
        os.chdir(spec["cwd"])
        os.execvpe(argv[0], argv, env)

    output = b""
    cursor = 0
    done = 0
    timed_out = False

    def pump(seconds: float) -> bool:
        """Reads for up to `seconds`. False once the command's side has closed."""
        nonlocal output
        ready, _, _ = select.select([fd], [], [], max(0.0, seconds))
        if not ready:
            return True
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            # Linux reports the far end closing as EIO rather than as EOF.
            return False
        if not chunk:
            return False
        output += chunk
        return True

    alive = True
    while alive:
        if time.monotonic() > deadline:
            timed_out = True
            break
        if done < len(steps):
            step = steps[done]
            found = output.find(step["wait"].encode("utf-8"), cursor)
            if found != -1:
                cursor = found + len(step["wait"].encode("utf-8"))
                pause = time.monotonic() + float(step.get("delay", 0.2))
                while alive and time.monotonic() < pause:
                    alive = pump(pause - time.monotonic())
                if not alive:
                    break
                try:
                    if "remove" in step:
                        os.remove(step["remove"])
                    elif "signal" in step:
                        os.kill(pid, getattr(signal, "SIG" + step["signal"]))
                    else:
                        os.write(fd, step["send"].encode("utf-8"))
                except OSError:
                    break
                done += 1
                continue
        alive = pump(0.1)

    status = None
    signalled = None
    if timed_out:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    _, raw = os.waitpid(pid, 0)
    if os.WIFEXITED(raw):
        status = os.WEXITSTATUS(raw)
    elif os.WIFSIGNALED(raw):
        signalled = os.WTERMSIG(raw)
    os.close(fd)

    json.dump(
        {
            "status": status,
            "signal": signalled,
            "timedOut": timed_out,
            "stepsDone": done,
            "output": output.decode("utf-8", errors="replace"),
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
