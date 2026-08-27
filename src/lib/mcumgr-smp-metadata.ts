export type SmpRequestResponse = 'request' | 'response' | 'unknown';

export const SMP_OP_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'Read request',
  1: 'Read response',
  2: 'Write request',
  3: 'Write response',
});

export const SMP_GROUP_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'OS',
  1: 'Image',
  2: 'Statistics',
  3: 'Settings',
  8: 'File System',
  9: 'Shell',
  10: 'Enumeration',
  11: 'Transport',
  63: 'Zephyr',
});

const SMP_GROUP_NAMES_ZH: Readonly<Record<number, string>> = Object.freeze({
  0: '操作系统',
  1: '镜像',
  2: '统计',
  3: '设置',
  8: '文件系统',
  9: '命令行',
  10: '枚举',
  11: '传输',
  63: 'Zephyr',
});

const COMMAND_NAMES: Readonly<Record<number, Readonly<Record<number, string>>>> = Object.freeze({
  0: Object.freeze({
    0: 'Echo',
    1: 'Console echo control',
    2: 'Task statistics',
    3: 'Memory pool statistics',
    4: 'Date/time',
    5: 'Reset',
    6: 'MCUmgr parameters',
    7: 'Application info',
    8: 'Bootloader info',
  }),
  1: Object.freeze({ 0: 'Image state', 1: 'Image upload', 5: 'Image erase', 6: 'Slot info' }),
  2: Object.freeze({ 0: 'Statistics show', 1: 'Statistics list' }),
  3: Object.freeze({
    0: 'Read/write setting',
    1: 'Delete setting',
    2: 'Commit settings',
    3: 'Load/save settings',
  }),
  8: Object.freeze({
    0: 'Upload/download file',
    1: 'File status',
    2: 'File checksum',
    3: 'Checksum types',
    4: 'Close file',
  }),
  9: Object.freeze({ 0: 'Execute command' }),
  10: Object.freeze({
    0: 'Count groups',
    1: 'List groups',
    2: 'Fetch group ID',
    3: 'Group details',
  }),
  11: Object.freeze({
    0: 'Connect transport',
    1: 'Disconnect transport',
    2: 'Transport status',
    6: 'List transports',
    7: 'Transport modes',
    8: 'Transport configuration',
  }),
  63: Object.freeze({ 0: 'Erase storage' }),
});

const COMMAND_NAMES_ZH: Readonly<Record<number, Readonly<Record<number, string>>>> = Object.freeze({
  0: Object.freeze({
    0: '回显',
    1: '终端回显控制',
    2: '任务统计',
    3: '内存池统计',
    4: '日期与时间',
    5: '复位',
    6: 'MCUmgr 参数',
    7: '应用信息',
    8: '引导程序信息',
  }),
  1: Object.freeze({ 0: '镜像状态', 1: '镜像上传', 5: '擦除镜像', 6: '槽位信息' }),
  2: Object.freeze({ 0: '查看统计', 1: '统计列表' }),
  3: Object.freeze({ 0: '读写设置', 1: '删除设置', 2: '提交设置', 3: '加载或保存设置' }),
  8: Object.freeze({
    0: '上传或下载文件',
    1: '文件状态',
    2: '文件校验和',
    3: '校验和类型',
    4: '关闭文件',
  }),
  9: Object.freeze({ 0: '执行命令' }),
  10: Object.freeze({ 0: '组数量', 1: '组列表', 2: '获取组 ID', 3: '组详情' }),
  11: Object.freeze({
    0: '连接传输',
    1: '断开传输',
    2: '传输状态',
    6: '传输列表',
    7: '传输模式',
    8: '传输配置',
  }),
  63: Object.freeze({ 0: '擦除存储' }),
});

export function smpGroupName(group: number): string {
  return SMP_GROUP_NAMES[group] ?? (group >= 64 ? `User group ${group}` : `Group ${group}`);
}

export function smpGroupNameZh(group: number): string {
  return SMP_GROUP_NAMES_ZH[group] ?? (group >= 64 ? `用户组 ${group}` : `组 ${group}`);
}

export function smpCommandName(group: number, command: number): string {
  return COMMAND_NAMES[group]?.[command] ?? `Command ${command}`;
}

export function smpCommandNameZh(group: number, command: number): string {
  return COMMAND_NAMES_ZH[group]?.[command] ?? `命令 ${command}`;
}

export function isKnownSmpCommand(group: number, command: number): boolean {
  return COMMAND_NAMES[group]?.[command] !== undefined;
}

export function smpOpName(op: number): string {
  return SMP_OP_NAMES[op] ?? `Operation ${op}`;
}

export function smpOpNameZh(op: number): string {
  if (op === 0) return '读请求';
  if (op === 1) return '读响应';
  if (op === 2) return '写请求';
  if (op === 3) return '写响应';
  return `操作 ${op}`;
}

export function smpRequestResponse(op: number): SmpRequestResponse {
  if (op === 0 || op === 2) return 'request';
  if (op === 1 || op === 3) return 'response';
  return 'unknown';
}

export function expectedResponseOp(op: number): number | null {
  if (op === 0) return 1;
  if (op === 2) return 3;
  return null;
}

const DIAGNOSTIC_NAMES_ZH: Readonly<Record<string, string>> = Object.freeze({
  'smp.console.timeout': 'Serial Console 报文重组超时',
  'smp.raw.timeout': 'Raw UART 报文重组超时',
  'smp.console.line-overflow': 'Serial Console 行超过解析限制',
  'smp.console.restarted': '上一报文尚未完成时收到新的起始片',
  'smp.console.base64': 'Serial Console 分片包含无效 Base64',
  'smp.console.length-missing': '起始分片缺少报文长度',
  'smp.console.length-invalid': 'Serial Console 报文长度超出限制',
  'smp.console.orphan-continuation': '续片缺少对应的起始片',
  'smp.console.trailing-bytes': 'Serial Console 报文包含多余字节',
  'smp.console.crc': 'CRC16-XMODEM 校验失败',
  'smp.raw.resync': 'Raw UART 正在丢弃噪声并重新同步',
  'smp.packet.trailing-bytes': 'SMP 包末尾不足一个完整报文头',
  'smp.packet.length': 'SMP 报文长度无效或超出限制',
  'smp.packet.padding': '多报文对齐填充不是零值',
  'smp.header.reserved': 'SMP 保留位不是零',
  'smp.header.version': 'SMP 版本值未知',
  'smp.header.op': 'SMP 操作码未知',
  'smp.header.flags': 'SMP 标志位尚未定义',
  'smp.header.custom-group': 'SMP 用户自定义组',
  'smp.header.unknown-group': 'SMP 组未知',
  'smp.header.unknown-command': 'SMP 命令未知',
  'smp.cbor.invalid': 'CBOR 解码失败，已保留原始数据',
  'smp.remote-error': '远端返回管理错误',
  'smp.transaction.orphan-response': '未找到匹配的 SMP 请求',
  'smp.transaction.unmatched-request': 'SMP 请求未获得匹配响应',
  'smp.runtime.replay-backlog': '实时积压超限，已放弃历史重放并继续实时解析',
});

export function smpDiagnosticMessageZh(code: string, fallback: string): string {
  const translated = DIAGNOSTIC_NAMES_ZH[code];
  return translated ? `${translated}（${fallback}）` : fallback;
}
