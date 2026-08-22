// Cross-feature type barrel. Feature-owned shapes live under `features/*/domain/`.
//
// This file re-exports the per-domain modules so existing `from '@/types'`
// imports keep resolving unchanged. New code should import from the feature
// domain module (e.g. `from '@/features/terminal/domain/modbus'`) so
// dependencies stay explicit and tree-shakeable.
//
// Cross-feature only (remain in src/types/):
//   display   — display/view/filter primitives
//   checksum  — checksum algorithm identifier
//   errors    — shared error shapes
//   constants — numeric budget limits
//
// Feature-owned (re-exported via shims in src/types/):
//   capture, session, serial, macros, modbus, serial-shell, mcumgr, waveform, ai

export * from './display';
export * from './capture';
export * from './errors';
export * from './serial';
export * from './macros';
export * from './modbus';
export * from './serial-shell';
export * from './mcumgr';
export * from './waveform';
export * from './ai';
export * from './session';
export * from './checksum';
export * from './constants';
