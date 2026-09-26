/**
 * Shared indexing/progress state for the safe pipeline: the workspace-scan
 * status payload reads it, and the scan/population/flush call sites mark
 * themselves active. Lives outside the handler so utils modules can report
 * without importing a handler (and without an import cycle).
 */

export interface PopulationProgress {
  done: number;
  total: number;
}

let activeScanCount = 0;
let lastScanAt: string | null = null;
let populationProgress: PopulationProgress | null = null;

export function setIndexingState(inProgress: boolean): void {
  if (inProgress) {
    activeScanCount++;
  } else {
    activeScanCount = Math.max(0, activeScanCount - 1);
  }
  if (activeScanCount === 0) {
    lastScanAt = new Date().toISOString();
  }
}

export function setPopulationProgress(progress: PopulationProgress | null): void {
  populationProgress = progress;
}

export function getScanState(): {
  indexing: boolean;
  lastScanAt: string | null;
  progress: PopulationProgress | null;
} {
  return { indexing: activeScanCount > 0, lastScanAt, progress: populationProgress };
}
