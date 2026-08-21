import type { McumgrClientConfig } from '../../types/mcumgr';
import { DEFAULT_MCUMGR_CONFIG } from './config';
import { emptyCborMap } from './cbor';
import { SMP_GROUP, SMP_OP } from './smp';
import { createMcumgrTransport, type McumgrTransportCodec } from './transport';
import {
  McumgrTransactionRunner,
  type McumgrTransactionRequest,
  type McumgrWriteResult,
} from './transaction';
import { decodeCborMap } from './cbor';
import {
  decodeOsApplicationInfo,
  decodeOsDatetime,
  decodeOsEcho,
  decodeOsMemoryPools,
  decodeOsParameters,
  decodeOsTasks,
  encodeOsApplicationInfo,
  encodeOsBootloaderInfo,
  encodeOsConsoleEcho,
  encodeOsDatetimeSet,
  encodeOsEcho,
  encodeOsReset,
  OS_CMD,
} from './groups/os';
import {
  decodeImageState,
  encodeImageErase,
  encodeImageStateSet,
  IMAGE_CMD,
  type McumgrImageState,
} from './groups/image';
import { decodeShellExecute, encodeShellExecute, splitShellArgv, SHELL_CMD } from './groups/shell';
import {
  decodeFsHash,
  decodeFsHashTypes,
  decodeFsStatus,
  encodeFsHash,
  encodeFsStatus,
  FS_CMD,
} from './groups/fs';
import {
  decodeSettingsRead,
  encodeSettingsDelete,
  encodeSettingsRead,
  encodeSettingsSave,
  encodeSettingsWrite,
  SETTINGS_CMD,
} from './groups/settings';
import { decodeStatsGroup, decodeStatsList, encodeStatsGroup, STATS_CMD } from './groups/stats';
import {
  decodeEnumCount,
  decodeEnumList,
  decodeEnumSingle,
  encodeEnumDetails,
  encodeEnumSingle,
  ENUM_CMD,
} from './groups/enum';
import { encodeZephyrEraseStorage, ZEPHYR_CMD } from './groups/zephyr';
import { formatCborPreview } from './groups/raw';
import { downloadFile, uploadFile } from './file-transfer';
import { uploadImage } from './image-upload';
import type { McumgrByteSource } from './sha256';

export interface McumgrClientOptions {
  write: (payload: Uint8Array) => Promise<McumgrWriteResult>;
  config: () => McumgrClientConfig;
}

export class McumgrClient {
  private transport: McumgrTransportCodec;
  private readonly runner: McumgrTransactionRunner;
  private readonly options: McumgrClientOptions;

  constructor(options: McumgrClientOptions) {
    this.options = options;
    this.transport = createMcumgrTransport(options.config().transport, options.config().lineLength);
    this.runner = new McumgrTransactionRunner({
      write: options.write,
      getTransport: () => this.transport,
      getTimeoutMs: () => this.options.config().timeoutMs,
      getRetries: () => this.options.config().retries,
    });
  }

  receive(bytes: Uint8Array): void {
    this.runner.receive(bytes);
  }

  cancel(): void {
    this.runner.cancel();
  }

  resetTransport(): void {
    this.rebuildTransport();
    this.runner.reset();
  }

  hasPending(): boolean {
    return this.runner.hasPending();
  }

  rebuildTransport(): void {
    const config = this.options.config();
    this.transport = createMcumgrTransport(config.transport, config.lineLength);
  }

  transact(request: Omit<McumgrTransactionRequest, 'version'> & { version?: 1 | 2 }) {
    const config = this.options.config();
    return this.runner.transact({
      ...request,
      version: request.version ?? config.smpVersion,
    });
  }

  async echo(text: string): Promise<string> {
    const packet = await this.transact({
      op: SMP_OP.write,
      group: SMP_GROUP.os,
      command: OS_CMD.echo,
      payload: encodeOsEcho(text),
    });
    return decodeOsEcho(packet.payload);
  }

  async consoleEcho(echo: boolean): Promise<void> {
    await this.transact({
      op: SMP_OP.write,
      group: SMP_GROUP.os,
      command: OS_CMD.consoleEcho,
      payload: encodeOsConsoleEcho(echo),
    });
  }

  async reset(input?: { force?: boolean; bootMode?: number }): Promise<void> {
    await this.transact({
      op: SMP_OP.write,
      group: SMP_GROUP.os,
      command: OS_CMD.reset,
      payload: encodeOsReset(input),
    });
  }

  async parameters() {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.os,
      command: OS_CMD.parameters,
      payload: emptyCborMap(),
    });
    return decodeOsParameters(packet.payload);
  }

  async applicationInfo(format = 'a'): Promise<string> {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.os,
      command: OS_CMD.applicationInfo,
      payload: encodeOsApplicationInfo(format),
    });
    return decodeOsApplicationInfo(packet.payload);
  }

  async bootloaderInfo(query?: string) {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.os,
      command: OS_CMD.bootloaderInfo,
      payload: encodeOsBootloaderInfo(query),
    });
    return decodeCborMap(packet.payload);
  }

  async datetimeGet(): Promise<string> {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.os,
      command: OS_CMD.datetime,
      payload: emptyCborMap(),
    });
    return decodeOsDatetime(packet.payload);
  }

  async datetimeSet(value: string): Promise<void> {
    await this.transact({
      op: SMP_OP.write,
      group: SMP_GROUP.os,
      command: OS_CMD.datetime,
      payload: encodeOsDatetimeSet(value),
    });
  }

  async tasks() {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.os,
      command: OS_CMD.tasks,
      payload: emptyCborMap(),
    });
    return decodeOsTasks(packet.payload);
  }

  async memoryPools() {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.os,
      command: OS_CMD.memoryPools,
      payload: emptyCborMap(),
    });
    return decodeOsMemoryPools(packet.payload);
  }

  async imageState(): Promise<McumgrImageState> {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.image,
      command: IMAGE_CMD.state,
      payload: emptyCborMap(),
    });
    return decodeImageState(packet.payload);
  }

  async imageTest(hash: Uint8Array): Promise<McumgrImageState> {
    const packet = await this.transact({
      op: SMP_OP.write,
      group: SMP_GROUP.image,
      command: IMAGE_CMD.state,
      payload: encodeImageStateSet({ hash, confirm: false }),
    });
    return decodeImageState(packet.payload);
  }

  async imageConfirm(hash?: Uint8Array): Promise<McumgrImageState> {
    const packet = await this.transact({
      op: SMP_OP.write,
      group: SMP_GROUP.image,
      command: IMAGE_CMD.state,
      payload: encodeImageStateSet({ hash, confirm: true }),
    });
    return decodeImageState(packet.payload);
  }

  async imageErase(slot?: number): Promise<void> {
    await this.transact({
      op: SMP_OP.write,
      group: SMP_GROUP.image,
      command: IMAGE_CMD.erase,
      payload: encodeImageErase(slot),
      timeoutMs: this.options.config().firstChunkTimeoutMs,
    });
  }

  async imageSlotInfo() {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.image,
      command: IMAGE_CMD.slotInfo,
      payload: emptyCborMap(),
    });
    return decodeCborMap(packet.payload);
  }

  async imageUpload(
    source: McumgrByteSource,
    extras: {
      image?: number;
      upgrade?: boolean;
      onProgress?: (offset: number, total: number) => void;
      signal?: AbortSignal;
    } = {},
  ) {
    const config = this.options.config();
    return uploadImage({
      source,
      mtu: config.mtu,
      image: extras.image,
      upgrade: extras.upgrade,
      firstTimeoutMs: config.firstChunkTimeoutMs,
      subsequentTimeoutMs: config.subsequentTimeoutMs,
      transact: (request) => this.transact(request),
      onProgress: extras.onProgress,
      signal: extras.signal,
    });
  }

  async shellExecute(line: string) {
    const argv = splitShellArgv(line);
    const packet = await this.transact({
      op: SMP_OP.write,
      group: SMP_GROUP.shell,
      command: SHELL_CMD.execute,
      payload: encodeShellExecute(argv),
    });
    return decodeShellExecute(packet.payload);
  }

  async fsStatus(name: string) {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.fs,
      command: FS_CMD.status,
      payload: encodeFsStatus(name),
    });
    return decodeFsStatus(packet.payload);
  }

  async fsHash(name: string, type?: string) {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.fs,
      command: FS_CMD.hash,
      payload: encodeFsHash({ name, type }),
    });
    return decodeFsHash(packet.payload);
  }

  async fsHashTypes() {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.fs,
      command: FS_CMD.hashTypes,
      payload: emptyCborMap(),
    });
    return decodeFsHashTypes(packet.payload);
  }

  async fsClose(): Promise<void> {
    await this.transact({
      op: SMP_OP.write,
      group: SMP_GROUP.fs,
      command: FS_CMD.close,
      payload: emptyCborMap(),
    });
  }

  async fsUpload(
    name: string,
    source: McumgrByteSource,
    extras: { onProgress?: (offset: number, total: number) => void; signal?: AbortSignal } = {},
  ) {
    const config = this.options.config();
    return uploadFile({
      name,
      source,
      mtu: config.mtu,
      firstTimeoutMs: config.firstChunkTimeoutMs,
      subsequentTimeoutMs: config.subsequentTimeoutMs,
      transact: (request) => this.transact(request),
      onProgress: extras.onProgress,
      signal: extras.signal,
    });
  }

  async fsDownload(
    name: string,
    extras: { onProgress?: (offset: number, total: number) => void; signal?: AbortSignal } = {},
  ) {
    const config = this.options.config();
    return downloadFile({
      name,
      mtu: config.mtu,
      firstTimeoutMs: config.firstChunkTimeoutMs,
      subsequentTimeoutMs: config.subsequentTimeoutMs,
      transact: (request) => this.transact(request),
      onProgress: extras.onProgress,
      signal: extras.signal,
    });
  }

  async settingsRead(name: string, maxSize?: number) {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.settings,
      command: SETTINGS_CMD.readWrite,
      payload: encodeSettingsRead(name, maxSize),
    });
    return decodeSettingsRead(packet.payload);
  }

  async settingsWrite(name: string, val: Uint8Array): Promise<void> {
    await this.transact({
      op: SMP_OP.write,
      group: SMP_GROUP.settings,
      command: SETTINGS_CMD.readWrite,
      payload: encodeSettingsWrite(name, val),
    });
  }

  async settingsDelete(name: string): Promise<void> {
    await this.transact({
      op: SMP_OP.write,
      group: SMP_GROUP.settings,
      command: SETTINGS_CMD.delete,
      payload: encodeSettingsDelete(name),
    });
  }

  async settingsCommit(): Promise<void> {
    await this.transact({
      op: SMP_OP.write,
      group: SMP_GROUP.settings,
      command: SETTINGS_CMD.commit,
      payload: emptyCborMap(),
    });
  }

  async settingsLoad(): Promise<void> {
    await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.settings,
      command: SETTINGS_CMD.loadSave,
      payload: emptyCborMap(),
    });
  }

  async settingsSave(name?: string): Promise<void> {
    await this.transact({
      op: SMP_OP.write,
      group: SMP_GROUP.settings,
      command: SETTINGS_CMD.loadSave,
      payload: encodeSettingsSave(name),
    });
  }

  async statsList() {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.stats,
      command: STATS_CMD.list,
      payload: emptyCborMap(),
    });
    return decodeStatsList(packet.payload);
  }

  async statsShow(name: string) {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.stats,
      command: STATS_CMD.group,
      payload: encodeStatsGroup(name),
    });
    return decodeStatsGroup(packet.payload);
  }

  async enumCount() {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.enum,
      command: ENUM_CMD.count,
      payload: emptyCborMap(),
    });
    return decodeEnumCount(packet.payload);
  }

  async enumList() {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.enum,
      command: ENUM_CMD.list,
      payload: emptyCborMap(),
    });
    return decodeEnumList(packet.payload);
  }

  async enumSingle(index: number) {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.enum,
      command: ENUM_CMD.single,
      payload: encodeEnumSingle(index),
    });
    return decodeEnumSingle(packet.payload);
  }

  async enumDetails(groups?: readonly number[]) {
    const packet = await this.transact({
      op: SMP_OP.read,
      group: SMP_GROUP.enum,
      command: ENUM_CMD.details,
      payload: encodeEnumDetails(groups),
    });
    return formatCborPreview(packet.payload);
  }

  async zephyrEraseStorage(): Promise<void> {
    await this.transact({
      op: SMP_OP.write,
      group: SMP_GROUP.zephyr,
      command: ZEPHYR_CMD.eraseStorage,
      payload: encodeZephyrEraseStorage(),
      timeoutMs: this.options.config().firstChunkTimeoutMs,
    });
  }

  async rawExecute(input: {
    group: number;
    command: number;
    op: typeof SMP_OP.read | typeof SMP_OP.write;
    payload: Uint8Array;
  }) {
    const packet = await this.transact({
      op: input.op,
      group: input.group,
      command: input.command,
      payload: input.payload,
    });
    return {
      header: packet.header,
      preview: formatCborPreview(packet.payload),
      payload: packet.payload,
    };
  }
}

export const MCUMGR_LEASE_OWNER = 'mcumgr-client';

export function defaultClientConfig(): McumgrClientConfig {
  return { ...DEFAULT_MCUMGR_CONFIG, shellHistory: [] };
}
