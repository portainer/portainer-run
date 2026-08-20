// Runtime detection for the deploy form.
//
// The catalogue itself lives in shared/runtimes.js so that the browser UI, the
// MCP server and the manifest builder all deploy a given runtime identically.
// This module exists only to give the React components a typed view of it —
// add or change runtimes in shared/runtimes.js, not here.
import { detectRuntime as detectRuntimeShared } from '@shared/runtimes.js'

export interface RuntimeDef {
  id: string
  label: string
  image: string
  detect?: (names: string[]) => boolean
  defaultCmd: (files: { name: string; text: string }[]) => string
  port: number
  workDir: string
}

export function detectRuntime(
  files: { name: string; text: string }[],
): RuntimeDef {
  return detectRuntimeShared(files) as RuntimeDef
}
