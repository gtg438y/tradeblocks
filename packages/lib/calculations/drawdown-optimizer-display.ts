import type { TimeUnit } from "../utils/time-conversions";

export interface ComparisonColumnDisplay {
  isWinner: boolean;
  badge?: string;
}

export interface DrawdownComparisonDisplay {
  baseline: ComparisonColumnDisplay;
  optimized: ComparisonColumnDisplay;
}

/**
 * Resolves winner highlighting and badges for baseline vs optimized columns.
 */
export function getDrawdownComparisonDisplay(
  improved: boolean
): DrawdownComparisonDisplay {
  if (improved) {
    return {
      baseline: { isWinner: false },
      optimized: { isWinner: true, badge: "Winner" },
    };
  }

  return {
    baseline: { isWinner: true, badge: "Winner" },
    optimized: { isWinner: false, badge: "No improvement" },
  };
}

export const DRAWDOWN_OPTIMIZER_DEFAULTS = {
  preloadInitialCapital: 35_000,
  simulationPeriodValue: 1,
  simulationPeriodUnit: "months" as TimeUnit,
  resamplePercentage: 100,
  searchSimulations: 2000,
  finalSimulations: 10_000,
  useFixedSeed: true,
  seedValue: 42,
  worstCaseEnabled: true,
  worstCasePercentage: 3,
  worstCaseMode: "pool" as const,
  worstCaseBasedOn: "simulation" as const,
  worstCaseSizing: "relative" as const,
  weightMin: 0,
  weightMax: 3,
  weightStep: 1,
  useFractionalWeights: false,
  maxPasses: 5,
  maxZeroFraction: 0.1,
  resampleMethod: "trades" as const,
  normalizeTo1Lot: false,
};
