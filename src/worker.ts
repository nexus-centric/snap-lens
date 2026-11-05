// Web Worker for analysis work that would otherwise block the UI:
// reference statistics, target statistics and copy-style fitting.
import { analyze, analyzeTarget, StyleData, TargetData } from './core/stats.js';
import { fitLook, FitResult, SpatialFeatures } from './core/fit.js';

export type WorkerRequest =
  | { id: number; kind: 'analyze'; pixels: Uint8ClampedArray; name: string; sources: number }
  | { id: number; kind: 'target'; pixels: Uint8ClampedArray }
  | { id: number; kind: 'fit'; ref: Float32Array; target: Float32Array; refSp?: SpatialFeatures; tgtSp?: SpatialFeatures };

export type WorkerResponse =
  | { id: number; ok: true; style?: StyleData; target?: TargetData; fit?: FitResult }
  | { id: number; ok: false; error: string };

const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  try {
    if (m.kind === 'analyze') post({ id: m.id, ok: true, style: analyze(m.pixels, m.name, m.sources, 7) });
    else if (m.kind === 'target') post({ id: m.id, ok: true, target: analyzeTarget(m.pixels) });
    else post({ id: m.id, ok: true, fit: fitLook(m.ref, m.target, m.refSp, m.tgtSp) });
  } catch (err) {
    post({ id: m.id, ok: false, error: String(err) });
  }
};
