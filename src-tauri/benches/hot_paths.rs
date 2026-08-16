//! Microbenchmarks for the Rust-side hot paths: CRC checksums (used by the
//! send-with-checksum feature on every TX), HEX/log-text formatting, the
//! export formatter (runs over up to 100k frames on export), the workspace
//! SQLite batch-commit path, and timestamp formatting. Run with `cargo bench`
//! (or `pnpm bench:rust`).
//!
//! These exist to lock in the current performance and catch regressions — the
//! values are already fast, the benches make sure they stay that way.

use base64::Engine as _;
use bbcom::models::data_frame::{DataFrame, Direction};
use bbcom::utils::timestamp::format_timestamp_ms_into;
use bbcom::utils::{checksum, hex, log_text};
use bbcom_contracts::{
    ApplyWorkspaceBatchRequest, Direction as FrameDirection, WorkspaceAppendFramesPayload,
    WorkspaceFramePayload, WorkspaceMutation, WorkspaceSessionKind, WorkspaceSessionUpsertPayload,
};
use bbcom_workspace::{CreateWorkspaceRequest, WorkspaceService};
use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::hint::black_box;
use std::io::Write as _;
use std::path::PathBuf;

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
            direction: if i.is_multiple_of(2) {
                Direction::Tx
            } else {
                Direction::Rx
            },
            timestamp: i as f64,
            data: bench_data(64),
            data_b64: None,
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

/// One full-size capture-write batch: 256 frames of 2 KiB (the documented
/// 512 KiB batch budget), appended to a live session in a real managed SQLite
/// workspace so per-batch statement preparation, commit fsync, and the WAL
/// checkpoint are all measured.
const BATCH_FRAMES: usize = 256;
const FRAME_BYTES: usize = 2 * 1024;
/// Recreate the workspace after this many batches so the benchmark database
/// cannot grow without bound over the measurement window.
const BATCHES_PER_EPOCH: u32 = 16;
const BENCH_WORKSPACE_ID: &str = "bench-workspace-1";
const BENCH_SESSION_ID: &str = "bench-session-1";

fn bench_frame(batch: u64, id: usize, offset: u8) -> WorkspaceFramePayload {
    WorkspaceFramePayload {
        id: format!("b{batch}-f{id}"),
        direction: if id.is_multiple_of(2) {
            FrameDirection::Tx
        } else {
            FrameDirection::Rx
        },
        timestamp_ms: 1_747_000_000_000 + (id as u64 % 60_000),
        data: vec![offset.wrapping_add(id as u8); FRAME_BYTES],
        data_b64: None,
        tx_status: None,
        requested_bytes: None,
        omitted_bytes: None,
    }
}

struct BatchWorkspace {
    service: WorkspaceService,
    path: PathBuf,
    base_revision: u64,
    next_seq: u64,
    batches_in_epoch: u32,
    batch_counter: u64,
}

impl BatchWorkspace {
    fn open(path: &PathBuf) -> Self {
        // A fresh epoch starts from an empty file: drop any previous database
        // and its WAL/SHM sidecars so `WorkspaceService::create` succeeds.
        for suffix in ["", "-wal", "-shm"] {
            let mut sidecar = path.as_os_str().to_owned();
            sidecar.push(suffix);
            let _ = std::fs::remove_file(std::path::Path::new(&sidecar));
        }
        let mut service = WorkspaceService::create(
            path,
            CreateWorkspaceRequest {
                workspace_id: BENCH_WORKSPACE_ID.to_owned(),
                name: "Bench project".to_owned(),
                created_at_ms: 1_747_000_000_000,
            },
        )
        .expect("create bench workspace");
        let response = service
            .apply_batch(ApplyWorkspaceBatchRequest {
                workspace_id: BENCH_WORKSPACE_ID.to_owned(),
                client_batch_id: "bench-session-bootstrap".to_owned(),
                base_revision: 0,
                mutations: vec![WorkspaceMutation::UpsertSession {
                    sequence: 0,
                    session_id: BENCH_SESSION_ID.to_owned(),
                    payload: WorkspaceSessionUpsertPayload {
                        name: "Bench session".to_owned(),
                        sort_order: 0,
                        kind: WorkspaceSessionKind::Live,
                        last_port_hint: None,
                        port_config: serde_json::json!({}),
                        document: serde_json::json!({}),
                    },
                }],
            })
            .expect("bootstrap bench session");
        Self {
            service,
            path: path.clone(),
            base_revision: response.committed_revision,
            next_seq: 0,
            batches_in_epoch: 0,
            batch_counter: 0,
        }
    }

    fn apply_append_batch(&mut self) -> u64 {
        if self.batches_in_epoch >= BATCHES_PER_EPOCH {
            let path = self.path.clone();
            *self = Self::open(&path);
        }
        let frames = (0..BATCH_FRAMES)
            .map(|index| bench_frame(self.batch_counter, index, (self.batch_counter % 251) as u8))
            .collect();
        self.batch_counter += 1;
        self.batches_in_epoch += 1;
        let response = self
            .service
            .apply_batch(ApplyWorkspaceBatchRequest {
                workspace_id: BENCH_WORKSPACE_ID.to_owned(),
                client_batch_id: format!("bench-batch-{}", self.batch_counter),
                base_revision: self.base_revision,
                mutations: vec![WorkspaceMutation::AppendFrames {
                    sequence: 0,
                    session_id: BENCH_SESSION_ID.to_owned(),
                    payload: WorkspaceAppendFramesPayload {
                        start_seq: self.next_seq,
                        frames,
                    },
                }],
            })
            .expect("apply bench batch");
        self.base_revision = response.committed_revision;
        self.next_seq += BATCH_FRAMES as u64;
        response.committed_revision
    }
}

fn bench_workspace_apply_batch(c: &mut Criterion) {
    let temp = tempfile::tempdir().expect("bench tempdir");
    let mut workspace = BatchWorkspace::open(&temp.path().join("bench.bbcom"));
    let batch_bytes = (BATCH_FRAMES * FRAME_BYTES) as u64;
    let mut group = c.benchmark_group("workspace_apply_batch");
    group
        .throughput(Throughput::Bytes(batch_bytes))
        .bench_function("append_256_frames_512kib", |b| {
            b.iter(|| black_box(workspace.apply_append_batch()));
        });
    group.finish();
}

/// Whole-session backend-sourced export: 10k small frames are written once
/// through the public mutation API (the same append path the renderer save
/// queue drives), then each measurement performs one complete backend export
/// — totals scan over the durable frames, bounded paging reads, jsonl
/// formatting into the backend-owned temp, and the atomic finish. This is the
/// DB-export counterpart of the renderer-streamed `export_format` bench.
const DB_EXPORT_WORKSPACE_ID: &str = "01234567-89ab-cdef-0123-456789abcdef";
const DB_EXPORT_SESSION_ID: &str = "bench-session-1";
const DB_EXPORT_FRAMES: usize = 10_000;
const DB_EXPORT_FRAME_BYTES: usize = 64;

fn bench_db_export_paging(c: &mut Criterion) {
    let temp = tempfile::tempdir().expect("bench tempdir");
    let root = temp.path().to_path_buf();
    let workspace_path = root.join(format!("{DB_EXPORT_WORKSPACE_ID}.bbcom"));

    let mut service = WorkspaceService::create(
        &workspace_path,
        CreateWorkspaceRequest {
            workspace_id: DB_EXPORT_WORKSPACE_ID.to_owned(),
            name: "DB export bench".to_owned(),
            created_at_ms: 1_747_000_000_000,
        },
    )
    .expect("create db export bench workspace");
    let mut revision = service
        .apply_batch(ApplyWorkspaceBatchRequest {
            workspace_id: DB_EXPORT_WORKSPACE_ID.to_owned(),
            client_batch_id: "db-export-bootstrap".to_owned(),
            base_revision: 0,
            mutations: vec![WorkspaceMutation::UpsertSession {
                sequence: 0,
                session_id: DB_EXPORT_SESSION_ID.to_owned(),
                payload: WorkspaceSessionUpsertPayload {
                    name: "DB export bench session".to_owned(),
                    sort_order: 0,
                    kind: WorkspaceSessionKind::Live,
                    last_port_hint: None,
                    port_config: serde_json::json!({}),
                    document: serde_json::json!({}),
                },
            }],
        })
        .expect("bootstrap db export bench session")
        .committed_revision;

    // Seed through the public mutation API in capture-sized append batches.
    let mut start_seq = 0_u64;
    let mut batch_counter = 0_u64;
    while start_seq < DB_EXPORT_FRAMES as u64 {
        let frames = (0..BATCH_FRAMES)
            .map(|index| WorkspaceFramePayload {
                id: format!("b{batch_counter}-f{index}"),
                direction: if index.is_multiple_of(2) {
                    FrameDirection::Tx
                } else {
                    FrameDirection::Rx
                },
                timestamp_ms: 1_747_000_000_000 + ((start_seq + index as u64) % 60_000),
                data: vec![(index % 251) as u8; DB_EXPORT_FRAME_BYTES],
                data_b64: None,
                tx_status: None,
                requested_bytes: None,
                omitted_bytes: None,
            })
            .collect::<Vec<_>>();
        batch_counter += 1;
        revision = service
            .apply_batch(ApplyWorkspaceBatchRequest {
                workspace_id: DB_EXPORT_WORKSPACE_ID.to_owned(),
                client_batch_id: format!("db-export-seed-{batch_counter}"),
                base_revision: revision,
                mutations: vec![WorkspaceMutation::AppendFrames {
                    sequence: 0,
                    session_id: DB_EXPORT_SESSION_ID.to_owned(),
                    payload: WorkspaceAppendFramesPayload { start_seq, frames },
                }],
            })
            .expect("seed db export bench frames")
            .committed_revision;
        start_seq += BATCH_FRAMES as u64;
    }
    drop(service);

    let runtime = tokio::runtime::Runtime::new().expect("bench tokio runtime");
    let mut group = c.benchmark_group("db_export_paging");
    group
        .throughput(Throughput::Elements(DB_EXPORT_FRAMES as u64))
        .bench_function("whole_session_jsonl_10k", |b| {
            b.iter(|| {
                runtime.block_on(async {
                    let source = std::sync::Arc::new(
                        bbcom::commands::export::ManagedWorkspaceFrameSource::open(
                            &root,
                            DB_EXPORT_WORKSPACE_ID,
                        )
                        .expect("open bench frame source"),
                    );
                    let manager = bbcom::export::session::ExportSessionManager::default();
                    let target = root.join(format!("db-export-{}.jsonl", std::process::id()));
                    let begin = manager
                        .begin_backend_sourced(
                            bbcom::export::ExportFormat::Jsonl,
                            target.clone(),
                            source,
                            bbcom::export::session::WorkspaceFrameQuery {
                                workspace_id: DB_EXPORT_WORKSPACE_ID.to_owned(),
                                session_id: DB_EXPORT_SESSION_ID.to_owned(),
                                to_seq_exclusive: DB_EXPORT_FRAMES as u64,
                            },
                        )
                        .await
                        .expect("begin backend-sourced export");
                    let stats = manager
                        .finish(&begin.export_id)
                        .await
                        .expect("finish export");
                    std::fs::remove_file(&target).ok();
                    stats
                })
            })
        });
    group.finish();
}

/// Wire shapes compared for the byte-carrying IPC payloads (export batches,
/// workspace frame appends, checksum input). `Vec<u8>` serializes as a JSON
/// number array (~4x expansion per byte); the base64 channel trades that for a
/// 4/3 string plus one encode/decode pass.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NumberArrayWire<'a> {
    data: &'a [u8],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NumberArrayPayload {
    data: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Base64Wire<'a> {
    data_b64: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Base64Payload {
    data_b64: String,
}

fn bench_ipc_payload(c: &mut Criterion) {
    let engine = base64::engine::general_purpose::STANDARD;
    let mut group = c.benchmark_group("ipc_payload");
    for size in [64_usize, 4 * 1024, 512 * 1024] {
        let data = bench_data(size);
        group
            .throughput(Throughput::Bytes(size as u64))
            .bench_with_input(
                BenchmarkId::new("json_number_array", size),
                &data,
                |b, data| {
                    b.iter(|| {
                        let encoded = serde_json::to_vec(&NumberArrayWire {
                            data: black_box(data),
                        })
                        .unwrap();
                        let decoded: NumberArrayPayload = serde_json::from_slice(&encoded).unwrap();
                        black_box(decoded.data);
                    });
                },
            );
        group
            .throughput(Throughput::Bytes(size as u64))
            .bench_with_input(BenchmarkId::new("base64_string", size), &data, |b, data| {
                b.iter(|| {
                    let encoded_text = engine.encode(black_box(data));
                    let encoded = serde_json::to_vec(&Base64Wire {
                        data_b64: &encoded_text,
                    })
                    .unwrap();
                    let decoded: Base64Payload = serde_json::from_slice(&encoded).unwrap();
                    let bytes = engine.decode(decoded.data_b64).unwrap();
                    black_box(bytes);
                });
            });
    }
    group.finish();
}

fn bench_timestamp_format(c: &mut Criterion) {
    // Per-frame export/auto-log usage: a rotating set of distinct timestamps
    // spanning roughly a day and a half, formatted 4k times per measurement.
    // This exercises both the cached local-date prefix and the day rollover.
    let timestamps: Vec<u64> = (0..4_096)
        .map(|index| 1_747_000_000_000_u64 + u64::from((index % 2_048) as u32) * 61_000)
        .collect();
    let mut group = c.benchmark_group("timestamp_format");
    group
        .throughput(Throughput::Elements(timestamps.len() as u64))
        .bench_function("format_timestamp_4k", |b| {
            b.iter(|| {
                let mut buffer = String::with_capacity(24);
                let mut sink = 0usize;
                for value in &timestamps {
                    buffer.clear();
                    format_timestamp_ms_into(*value, &mut buffer);
                    sink = sink.wrapping_add(buffer.len());
                }
                black_box(sink)
            });
        });
    group.finish();
}

criterion_group!(
    benches,
    bench_checksums,
    bench_hex_format,
    bench_log_text,
    bench_export,
    bench_workspace_apply_batch,
    bench_db_export_paging,
    bench_ipc_payload,
    bench_timestamp_format
);
criterion_main!(benches);
