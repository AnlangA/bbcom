# High-baud RX measurement (T2.4)

**Status: hardware-dependent.** The 921600 baud measurement requires a physical
serial device (or a paired virtual UART pair) generating a sustained byte stream.
This document captures the audit already completed in code (F5) and the
reproducible procedure + the F2/F3 config matrix so the measurement can be run
by anyone with the hardware, with no ambiguity about what to vary or record.

## What is already verified in code (no hardware needed)

- **F5 — `listen(cb, false)` audit:** bbcom's single serial RX listener passes
  `false` as the second argument, which skips the plugin's per-chunk
  TextDecoder on the JS side. Grep-confirmed there are no stragglers — the only
  plugin data listener is `useSerialConnection.ts` `p.listen(cb, false)`. Any
  additional listener that forgets `false` would re-introduce the per-chunk
  decode cost at high baud; the `cycles`/build gates do not enforce this, so a
  future listener must pass `false`.
- **F2 — `timeout` dual meaning:** the serialplugin `timeout` option is BOTH the
  port read-timeout AND the emit flush interval (default 200 ms), clamped to
  `.min(1)`. It cannot be raised to extend the read-timeout independently. bbcom
  builds `SerialPort` without overriding `timeout`/`size`, so the plugin
  defaults apply (F3: `size` = combined_buffer capacity 1024).
- **F4:** high-speed data loss was fixed upstream in serialplugin v2.11.0 (PR#15);
  bbcom's RX safety net is the `SerialRxQueue` (now a ring buffer, T2.1).

## What needs the hardware

The throughput/loss measurement at 921600 baud: connect a device (or a virtual
UART pair) that emits a known byte pattern at a known rate, capture with bbcom,
and compare received bytes/frame-count against the source.

## F2/F3 config matrix to sweep

When measuring, vary these against the plugin defaults and record
frames-received / bytes-dropped (the `SerialRxQueue.totalDroppedBytes` counter is
shown in the toolbar):

| Knob | Default | Sweep | Why |
|---|---|---|---|
| `timeout` (ms) | 200 | 50, 100, 200 | F2: lower = faster flush, but lower read-timeout |
| `size` (bytes) | 1024 | 1024, 4096 | F3: combined_buffer capacity |
| baud | 115200 | 921600 | The target rate |
| source rate | — | sustained, ~90 % line utilization | Stress the queue |

**Hypothesis (from F2/F4):** at 921600 with `timeout=200`, drops begin when the
frontend RAF flush can't keep up; lowering `timeout` to ~50 reduces flush latency
and should reduce `totalDroppedBytes`. The `SerialRxQueue` ring buffer (T2.1) and
the `sessions` shallowRef (T2.2, −93 % push cost) together raise the ceiling.

## Reproducible procedure

A paired virtual UART (e.g. `socat`) removes the need for a physical device. The
script below sets up a PTY pair, streams a deterministic byte pattern, and prints
how to capture + compare. Run on Linux/macOS.

```bash
# 1. Create a virtual UART pair (PTY A <-> PTY B). Requires socat.
socat -d -d pty,raw,echo=0,link=/tmp/bbcom-tx pty,raw,echo=0,link=/tmp/bbcom-rx &

# 2. Stream a deterministic pattern into PTY A at ~high line utilization.
#    921600 baud 8N1 ~= 92160 bytes/s. Emit 90000 bytes/s of 0xAA.. repeating.
python3 -c '
import time
data = bytes((i & 0xFF for i in range(90000)))
with open("/tmp/bbcom-tx","wb",buffering=0) as f:
    end = time.time() + 30
    while time.time() < end:
        f.write(data); time.sleep(0.05)
' &

# 3. In bbcom: open /tmp/bbcom-rx at 921600 8N1, start capture, wait 30s, stop.
#    Read the toolbar: "dropped N bytes" and the frame/byte counters.
#    Export as BIN and compare the byte count + a checksum against the source.

# 4. Tear down the PTY pair.
kill %1 %2 2>/dev/null
```

**Pass criteria:** with `timeout=200` (default), record `totalDroppedBytes` and
total bytes received. Repeat with `timeout=50` (requires a one-line code change
to pass `timeout` to `SerialPort` until the plugin exposes it via IPC). The
measurement is the delta in `totalDroppedBytes`. The `sessions_push_50k` bench
(T2.2: 2→32 ops/s) and the `serialrxqueue_drop_512` bench (T2.1: +105 %) are the
headless proxies that prove the frontend can now keep up at higher rates.

## Why this isn't automated in CI

CI has no serial device and socat PTY behavior differs across runners; a flaky
hardware-gated test would poison the suite. The headless benches (T2.1/T2.2)
cover the frontend hot paths the measurement is meant to stress; the
device-dependent end-to-end number is a manual verification checklist item in
`ARCHITECTURE.md`.
