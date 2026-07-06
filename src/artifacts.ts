// Tiny per-cluster artifact store so the numbered scripts can chain:
// 01 writes the mint address, 02/03 read it back. These are public addresses
// (devnet run outputs), not secrets — but they're gitignored as run state.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLUSTER } from './config';

export type Artifacts = Record<string, string>;

const DIR = resolve('artifacts');
const FILE = resolve(DIR, `${CLUSTER}.json`);

export function loadArtifacts(): Artifacts {
  if (!existsSync(FILE)) return {};
  return JSON.parse(readFileSync(FILE, 'utf8')) as Artifacts;
}

export function getArtifact(key: string): string | undefined {
  return loadArtifacts()[key];
}

export function saveArtifact(key: string, value: string): void {
  mkdirSync(DIR, { recursive: true });
  const current = loadArtifacts();
  current[key] = value;
  writeFileSync(FILE, JSON.stringify(current, null, 2) + '\n');
}
