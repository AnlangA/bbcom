import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  DEFAULT_SMP_PARSER_CONFIG,
  ProtocolParser,
  type ByteParserConfig,
  type SmpParserConfig,
} from '@/lib/protocol-parser.ts';
import {
  SESSION_STORAGE_VERSION,
  cloneParserConfig,
  createSessionRecord,
  hydrateSession,
  normalizeParserState,
  parserStateRecoveredInvalidSmp,
  serializeSessionSnapshots,
} from '@/lib/session-persistence.ts';
import type { PortConfig } from '@/types/serial.ts';

interface LegacyParserCase {
  name: string;
  config: ByteParserConfig;
  presetId: string;
}

const LEGACY_PARSER_CASES: LegacyParserCase[] = [
  {
    name: 'delimiter',
    config: {
      kind: 'delimiter',
      delimiter: [0x00, 0x0d, 0x0a, 0xff],
      includeDelimiter: true,
    },
    presetId: 'legacy-delimiter',
  },
  {
    name: 'fixed',
    config: { kind: 'fixed', frameSize: 37 },
    presetId: 'legacy-fixed',
  },
  {
    name: 'length',
    config: {
      kind: 'length',
      lengthOffset: 2,
      lengthSize: 2,
      bigEndian: false,
      lengthAdjust: 4,
    },
    presetId: 'legacy-length',
  },
];

const PORT_CONFIG: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

test('SMP parser configuration exposes stable defaults and stays outside the legacy byte parser', () => {
  assert.deepEqual(DEFAULT_SMP_PARSER_CONFIG, {
    kind: 'mcumgr-smp',
    transport: 'serial-console',
    maxPacketBytes: 1024 * 1024,
    reassemblyTimeoutMs: 3000,
  });
  assert.throws(
    () => new ProtocolParser({ ...DEFAULT_SMP_PARSER_CONFIG }),
    /requires McumgrSmpParser/,
  );
});

test('SMP parser configuration clones valid values and normalizes malformed snapshots', () => {
  const config: SmpParserConfig = {
    kind: 'mcumgr-smp',
    transport: 'raw-uart',
    maxPacketBytes: 4096,
    reassemblyTimeoutMs: 1500,
  };
  const cloned = cloneParserConfig(config);
  assert.notEqual(cloned, config);
  assert.deepEqual(cloned, config);

  assert.deepEqual(
    normalizeParserState({
      config: { ...config },
      presetId: null,
    }),
    { config, presetId: null },
  );
  const recovered = normalizeParserState({
    config: {
      kind: 'mcumgr-smp',
      transport: 'auto',
      maxPacketBytes: 0,
      reassemblyTimeoutMs: -1,
    },
    presetId: 'stale-preset',
  });
  assert.deepEqual(recovered, { config: DEFAULT_SMP_PARSER_CONFIG, presetId: null });
  assert.equal(parserStateRecoveredInvalidSmp(recovered), true);
  assert.deepEqual(Object.keys(recovered), ['config', 'presetId']);
});

test.each(LEGACY_PARSER_CASES)(
  'legacy $name parser configuration clones and survives local JSON persistence',
  ({ name, config, presetId }) => {
    const cloned = cloneParserConfig(config);
    assert.notEqual(cloned, config);
    assert.deepEqual(cloned, config);
    if (config.kind === 'delimiter') {
      assert.equal(cloned.kind, 'delimiter');
      assert.notEqual(cloned.delimiter, config.delimiter);
    }

    const session = createSessionRecord(`local-${name}`, 'COM1', PORT_CONFIG, {
      parserState: { config, presetId },
    });
    const serialized = serializeSessionSnapshots([session], session.id);
    assert.equal(SESSION_STORAGE_VERSION, 2, 'legacy local-storage schema must not be bumped');
    assert.equal(serialized.version, 2);

    const jsonRoundTrip = JSON.parse(JSON.stringify(serialized)) as typeof serialized;
    assert.equal(jsonRoundTrip.version, 2);
    const persisted = jsonRoundTrip.sessions[0];
    assert.ok(persisted);
    assert.deepEqual(persisted.parserState, { config, presetId });
    assert.notEqual(persisted.parserState.config, config);

    const hydrated = hydrateSession(persisted);
    assert.ok(hydrated);
    assert.deepEqual(hydrated.parserState, { config, presetId });
    assert.notEqual(hydrated.parserState.config, persisted.parserState.config);

    if (
      config.kind === 'delimiter' &&
      persisted.parserState.config.kind === 'delimiter' &&
      hydrated.parserState.config.kind === 'delimiter'
    ) {
      assert.notEqual(persisted.parserState.config.delimiter, config.delimiter);
      assert.notEqual(
        hydrated.parserState.config.delimiter,
        persisted.parserState.config.delimiter,
      );
      const hydratedDelimiter = [...hydrated.parserState.config.delimiter];
      persisted.parserState.config.delimiter[0] = 0xaa;
      assert.deepEqual(hydrated.parserState.config.delimiter, hydratedDelimiter);
      assert.deepEqual(config.delimiter, [0x00, 0x0d, 0x0a, 0xff]);
    }
  },
);
