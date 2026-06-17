// Domain-typed barrel for the application's shared types.
//
// This file re-exports the per-domain modules so existing `from '../types'`
// (and `'.../types/index'`) imports keep resolving unchanged. New code should
// prefer importing from the specific domain module (e.g. `from '../types/modbus'`)
// so dependencies stay explicit and tree-shakeable.
//
// Domains:
//   display   — display/view/filter primitives
//   serial    — DataFrame, PortConfig, send history, quick commands
//   macros    — macros, triggers, highlight rules
//   modbus    — register model + master config
//   waveform  — waveform source mode
//   ai        — AI models, roles, context modes, chat messages
//   session   — SerialSession aggregate + parser state
//   checksum  — checksum algorithm identifier
//   constants — numeric budget limits

export * from './display';
export * from './serial';
export * from './macros';
export * from './modbus';
export * from './waveform';
export * from './ai';
export * from './session';
export * from './checksum';
export * from './constants';
