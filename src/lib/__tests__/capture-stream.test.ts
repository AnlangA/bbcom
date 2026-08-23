import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  captureDisplayCursorAtEnd,
  captureFrameIdentity,
  compareCaptureSeq,
  defaultCaptureOrigin,
  EMPTY_CAPTURE_DISPLAY_CURSOR,
  findCaptureFrameById,
  findCaptureFrameBySeq,
  planCaptureDisplayIngest,
  sessionCaptureTimeline,
} from '@/lib/capture-stream.ts';
import type { DataFrame } from '@/types/serial.ts';
import type { SerialSession } from '@/types/session.ts';

function frame(
  id: string,
  direction: DataFrame['direction'],
  captureSeq?: number,
  origin?: DataFrame['origin'],
): DataFrame {
  return {
    id,
    direction,
    timestamp: 1,
    data: new Uint8Array([1]),
    ...(captureSeq === undefined ? {} : { captureSeq }),
    ...(origin === undefined ? {} : { origin }),
  };
}

function sessionSlice(
  frames: DataFrame[],
  pausedFrames: DataFrame[] = [],
  capturePaused = false,
): Pick<SerialSession, 'frames' | 'pausedFrames' | 'capturePaused'> {
  return { frames, pausedFrames, capturePaused };
}

test('defaultCaptureOrigin maps TX/RX to serial ingress paths', () => {
  assert.equal(defaultCaptureOrigin('TX'), 'serial-tx');
  assert.equal(defaultCaptureOrigin('RX'), 'serial-rx');
});

test('sessionCaptureTimeline merges live and paused rows in order', () => {
  const live = [frame('a', 'RX', 0), frame('b', 'TX', 1)];
  const paused = [frame('c', 'RX', 2, 'mcumgr-trace')];
  const timeline = sessionCaptureTimeline(sessionSlice(live, paused, true));
  assert.equal(timeline.liveCount, 2);
  assert.equal(timeline.pausedCount, 1);
  assert.equal(timeline.totalCount, 3);
  assert.equal(timeline.capturePaused, true);
  assert.deepEqual(
    timeline.all.map((item) => item.id),
    ['a', 'b', 'c'],
  );
});

test('captureFrameIdentity and lookup helpers resolve by seq and id', () => {
  const timeline = sessionCaptureTimeline(sessionSlice([frame('a', 'RX', 3, 'serial-rx')]));
  const identity = captureFrameIdentity(timeline.all[0]!);
  assert.deepEqual(identity, {
    captureSeq: 3,
    frameId: 'a',
    direction: 'RX',
    origin: 'serial-rx',
    timestamp: 1,
  });
  assert.equal(findCaptureFrameBySeq(timeline, 3)?.id, 'a');
  assert.equal(findCaptureFrameById(timeline, 'a')?.captureSeq, 3);
  assert.equal(captureFrameIdentity(frame('x', 'TX', 0))?.origin, 'serial-tx');
});

test('compareCaptureSeq orders defined sequences before undefined', () => {
  assert.equal(compareCaptureSeq(1, 2), -1);
  assert.equal(compareCaptureSeq(undefined, 0), -1);
  assert.equal(compareCaptureSeq(0, undefined), 1);
});

test('planCaptureDisplayIngest appends from a fresh cursor and after overlap', () => {
  const first = frame('a', 'RX', 0);
  const second = frame('b', 'TX', 1);
  const initial = planCaptureDisplayIngest([first, second], EMPTY_CAPTURE_DISPLAY_CURSOR);
  assert.deepEqual(initial, {
    startIndex: 0,
    reset: false,
    nextCursor: { consumed: 2, lastFrameId: 'b' },
  });

  const third = frame('c', 'RX', 2);
  const appended = planCaptureDisplayIngest([first, second, third], initial.nextCursor);
  assert.equal(appended.startIndex, 2);
  assert.equal(appended.reset, false);
  assert.deepEqual(appended.nextCursor, captureDisplayCursorAtEnd([first, second, third]));
});

test('planCaptureDisplayIngest resets after clear, trim, or replaced overlap', () => {
  const cursor = captureDisplayCursorAtEnd([frame('a', 'RX', 0), frame('b', 'TX', 1)]);
  const cleared = planCaptureDisplayIngest([], cursor);
  assert.equal(cleared.reset, true);
  assert.deepEqual(cleared.nextCursor, EMPTY_CAPTURE_DISPLAY_CURSOR);

  const trimmed = planCaptureDisplayIngest([frame('b', 'TX', 1), frame('c', 'RX', 2)], cursor);
  assert.equal(trimmed.reset, false);
  assert.equal(trimmed.startIndex, 1);

  const replaced = planCaptureDisplayIngest([frame('x', 'RX', 8), frame('y', 'TX', 9)], cursor);
  assert.equal(replaced.reset, true);
  assert.equal(replaced.startIndex, 0);
});
