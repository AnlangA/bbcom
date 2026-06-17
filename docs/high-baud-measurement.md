# High-Baud Capture Measurement

This document captures the procedure for measuring bbcom's sustained RX
throughput at high baud rates (up to 921600), the relevant upstream-plugin
constraints, and why the end-to-end number is a **manual** verification item
rather than a CI gate (CI has no physical serial device).

It is referenced from `ARCHITECTURE.md` (manual-verification checklist) and
from the `CHANGELOG.md` T2.4 entry.

## Why this is manual

The hot paths that govern throughput at 921600 baud — the serialplugin RX
emit, the JS-side `SerialRxQueue` ring buffer, and the `sessions` store frame
push — are each covered by a headless benchmark. But the *end-to-end* number
(driver → kernel → plugin emit → JS → render) depends on a physical serial
device generating a sustained byte stream. CI runs on a headless Ubuntu runner
with no such device and no `socat` PTY pair wired to a real data source, so
the full loop can only be measured on a developer machine.

## Headless proxies (what CI *can* measure)

These benchmarks exercise the same code paths a 921600-baud capture stresses,
without hardware:

| Bench | What it stresses | Gate |
| --- | --- | --- |
| `serialrxqueue_drop_512` | `SerialRxQueue` overflow drop path (O(1) head-index) | 15% regression vs baseline |
| `sessions_push_50k` | 50 000-frame `addFrame` into the `shallowRef` store | 15% regression vs baseline |
| `concat_64chunks` | RX-flush `concatUint8Arrays` (per RAF tick) | 15% regression vs baseline |

Run them with `pnpm bench:frontend`. A baseline is stored in
`tests/frontend/.perf-baseline.json` (machine-local, git-ignored); refresh it
with `pnpm bench:frontend:write` after an intentional optimization.

## Upstream hard constraints (the F2 / F3 / F5 matrix)

These are decision boundaries inherited from `tauri-plugin-serialplugin`; they
are the knobs that most affect high-baud capture:

- **F2 — `timeout` is dual-purpose.** The serial port `timeout` value is BOTH
  the read-timeout AND the plugin's RX emit flush interval (default **200 ms**),
  clamped `.min(1)`. It therefore cannot be raised independently to extend the
  read-timeout. **Implication:** a larger `timeout` coalesces more bytes per
  emit (fewer JS round-trips, lower per-frame overhead) but adds latency; a
  smaller `timeout` lowers latency at the cost of more emits.
- **F3 — `size` is the read buffer.** Larger `size` lets the driver hand back
  bigger chunks per read, which pairs well with a larger `timeout` for
  throughput.
- **F5 — `listen(cb, false)` skips the per-chunk TextDecoder.** bbcom passes
  `false` on its single RX listener (audited, no stragglers), so binary data is
  not lossily decoded on the hot path — the frontend decodes lazily in the
  formatter.
- **F6 — `read()` is lossy-UTF8.** Binary data must use `read_binary` /
  `write_binary` (which bbcom does).

### F2/F3 sweep matrix

To find the best sustained-throughput config for a given device, sweep
`timeout` × `size`:

| Goal | `timeout` | `size` | Trade-off |
| --- | --- | --- | --- |
| Max throughput (bulk log) | large (e.g. 500 ms+) | large (e.g. 8 KiB) | higher latency, fewer emits |
| Balanced (default-ish) | 200 ms | default | moderate latency |
| Min latency (interactive) | small (e.g. 10 ms) | small | more emits, higher per-frame overhead |

## Reproducible socat / PTY procedure

When a physical device is unavailable, a `socat` PTY pair can synthesize a
sustained byte stream so the RX path can be exercised end-to-end on one
machine.

```bash
# 1. Create a PTY pair: one end is /tmp/bbcom-tx, the other /tmp/bbcom-rx
socat -d -d pty,raw,echo=0,link=/tmp/bbcom-rx pty,raw,echo=0,link=/tmp/bbcom-tx

# 2. In another terminal, pump a sustained byte stream into /tmp/bbcom-tx.
#    Example: 921600 baud ≈ 92 KB/s. Send a repeating pattern:
yes "0123456789ABCDEF" | dd bs=92160 count=1000 of=/tmp/bbcom-tx  # ~90 MB burst

# 3. Launch bbcom dev and connect to /tmp/bbcom-rx at the target baud/timeout/size.
pnpm tauri:dev
```

> Note: `socat` PTY throughput is not a calibrated substitute for a real UART
> — there is no clock/baud on a PTY. It validates the **bbcom RX pipeline**
> (queue → store → render) under a sustained stream, not the kernel/driver
> layer. For a driver-level number, use a physical device or a USB-to-serial
> loopback.

## Pass criteria

A high-baud capture is considered acceptable when, at the target config:

- No dropped bytes accumulate over a sustained capture (the StatusBar
  `dropped` counter stays at 0), and
- The UI remains interactive (the 50 k-frame `sessions_push_50k` headless proxy
  must stay within its 15% gate, confirming the store can keep up).

Record the result with the baud rate, the F2/F3 config, the capture duration,
the frame/byte count, and whether any bytes were dropped.
