//! Microbenchmarks for the Rust-side hot paths: CRC checksums (used by the
//! send-with-checksum feature on every TX), HEX/log-text formatting, and the
//! export formatter (runs over up to 100k frames on export). Run with
//! `cargo bench` (or `pnpm bench:rust`).
//!
//! These exist to lock in the current performance and catch regressions — the
//! values are already fast, the benches make sure they stay that way.

use bbcom::models::data_frame::{DataFrame, Direction};
use bbcom::utils::{checksum, hex, log_text};
use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use std::convert::Infallible;
use std::hint::black_box;
use std::io::Write as _;

fn bench_data(size: usize) -> Vec<u8> {
    let mut v = Vec::with_capacity(size);
    for i in 0..size {
        v.push((i.wrapping_mul(31)) as u8);
    }
    v
}

fn make_frames(count: usize) -> Vec<DataFrame> {
    (0..count)
        .map(|i| DataFrame {
            id: format!("f{i}"),
            direction: if i % 2 == 0 {
                Direction::Tx
            } else {
                Direction::Rx
            },
            timestamp: i as f64,
            data: bench_data(64),
        })
        .collect()
}

fn bench_checksums(c: &mut Criterion) {
    let payload = bench_data(256);
    let mut g = c.benchmark_group("checksum");
    for (algo, f) in [
        ("sum8", checksum::calculate_checksum as fn(&[u8]) -> String),
        ("crc8", checksum::calculate_crc8),
        ("crc16", checksum::calculate_crc16),
        ("crc32", checksum::calculate_crc32),
    ] {
        g.throughput(Throughput::Bytes(payload.len() as u64))
            .bench_function(algo, |b| b.iter(|| f(black_box(&payload))));
    }
    g.finish();
}

fn bench_hex_format(c: &mut Criterion) {
    let data = bench_data(256);
    c.bench_function("format_hex_256b", |b| {
        b.iter(|| hex::format_hex(black_box(&data)));
    });
    c.bench_function("append_hex_256b", |b| {
        b.iter(|| {
            let mut output = Vec::with_capacity(data.len() * 3);
            hex::append_hex(&mut output, black_box(&data));
            black_box(output)
        });
    });
    c.bench_function("visit_hex_dump_256b", |b| {
        b.iter(|| {
            let mut output = Vec::with_capacity(data.len() * 5);
            hex::visit_hex_dump_lines(black_box(&data), |line| {
                output.extend_from_slice(line);
                output.push(b'\n');
                Ok::<(), Infallible>(())
            })
            .unwrap();
            black_box(output)
        });
    });
}

fn bench_log_text(c: &mut Criterion) {
    let cases = [
        ("clean", b"I: serial log ready\n".repeat(256)),
        (
            "ansi",
            b"\x1b[32mI: serial log ready\x1b[0m\r\n".repeat(256),
        ),
        ("unterminated_osc", b"\x1b]x".repeat(1_536)),
        ("unterminated_osc_4x", b"\x1b]x".repeat(6_144)),
    ];
    let mut group = c.benchmark_group("log_text_visit");
    for (name, data) in &cases {
        group
            .throughput(Throughput::Bytes(data.len() as u64))
            .bench_with_input(*name, data, |b, data| {
                b.iter(|| {
                    let mut visited_bytes = 0;
                    log_text::visit_readable_log_lines(black_box(data), true, |line| {
                        visited_bytes += black_box(line).len();
                        Ok::<(), Infallible>(())
                    })
                    .unwrap();
                    black_box(visited_bytes)
                });
            });
    }
    group.finish();
}

fn bench_export(c: &mut Criterion) {
    // Serialize-only: measure the formatting/serialization cost without the
    // filesystem (which varies by machine and would add noise). We build the
    // output buffer the same way export_* does, into a Vec<u8>.
    let frames = make_frames(10_000);
    let mut g = c.benchmark_group("export_format");
    for n in [1_000usize, 10_000] {
        let slice = &frames[..n];
        g.throughput(Throughput::Elements(n as u64))
            .bench_with_input(BenchmarkId::new("jsonl", n), slice, |b, frames| {
                b.iter(|| {
                    let mut buf: Vec<u8> = Vec::with_capacity(frames.len() * 64);
                    for frame in frames {
                        serde_json::to_writer(&mut buf, frame).unwrap();
                        buf.push(b'\n');
                    }
                    black_box(buf);
                });
            });
        g.throughput(Throughput::Elements(n as u64))
            .bench_with_input(BenchmarkId::new("txt_hex", n), slice, |b, frames| {
                b.iter(|| {
                    let mut buf: Vec<u8> = Vec::with_capacity(frames.len() * 320);
                    for frame in frames {
                        hex::visit_hex_dump_lines(&frame.data, |line| {
                            write!(&mut buf, "[{}] TX | ", frame.timestamp).unwrap();
                            buf.extend_from_slice(line);
                            buf.push(b'\n');
                            Ok::<(), Infallible>(())
                        })
                        .unwrap();
                    }
                    black_box(buf);
                });
            });
    }
    g.finish();
}

criterion_group!(
    benches,
    bench_checksums,
    bench_hex_format,
    bench_log_text,
    bench_export
);
criterion_main!(benches);
