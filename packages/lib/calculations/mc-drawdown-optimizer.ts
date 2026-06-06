/**
 * Monte Carlo Drawdown Optimizer
 *
 * Per-strategy weight scaling and validation for drawdown optimization workflows.
 */

import { Trade } from "../models/trade";
import { toCsvRow } from "../utils/export-helpers";
import {
  runMonteCarloSimulation,
  type MonteCarloParams,
  type MonteCarloResult,
} from "./monte-carlo";
import { PortfolioStatsCalculator } from "./portfolio-stats";

export type TradeFingerprint = string;
export type TradeWeightMap = Map<TradeFingerprint, number>;
export type StrategyWeightMap = Map<string, number>;

export interface StrategySummary {
  strategy: string;
  tradeCount: number;
  totalPl: number;
  worstTradePl: number;
}

export interface WeightConstraints {
  min: number;
  max: number;
  step: number;
  /** Fraction of trades allowed at weight 0 (0–1). Default 0.1 = 10%. */
  maxZeroFraction: number;
}

export interface ValidateWeightsResult {
  valid: boolean;
  errors: string[];
}

export interface OptimizerProgressEvent {
  phase: "baseline" | "search" | "final";
  pass?: number;
  maxPasses?: number;
  strategyIndex?: number;
  strategyCount?: number;
  /** @deprecated Use strategyIndex — kept for backward compatibility */
  tradeIndex?: number;
  /** @deprecated Use strategyCount — kept for backward compatibility */
  tradeCount?: number;
  currentBestMdd: number;
}

export interface McDrawdownOptimizerParams {
  trades: Trade[];
  mcParams: Omit<MonteCarloParams, "numSimulations">;
  searchSimulations: number;
  finalSimulations: number;
  weightBounds: WeightConstraints;
  maxPasses: number;
  maxZeroFraction: number;
  epsilon: number;
  randomSeed?: number;
  signal?: AbortSignal;
  onProgress?: (event: OptimizerProgressEvent) => void;
  yieldToMain?: () => Promise<void>;
}

export interface McDrawdownOptimizerResult {
  baselineStrategyWeights: StrategyWeightMap;
  optimizedStrategyWeights: StrategyWeightMap;
  baselineStats: MonteCarloResult;
  optimizedStats: MonteCarloResult;
  improved: boolean;
  searchPhaseBaselineMdd: number;
  searchPhaseOptimizedMdd: number;
}

/** Legacy per-trade optimizer result (internal tests only). */
export interface McDrawdownTradeOptimizerResult {
  baselineWeights: TradeWeightMap;
  optimizedWeights: TradeWeightMap;
  baselineStats: MonteCarloResult;
  optimizedStats: MonteCarloResult;
  improved: boolean;
  searchPhaseBaselineMdd: number;
  searchPhaseOptimizedMdd: number;
}

export class OptimizationAbortedError extends Error {
  constructor() {
    super("Optimization aborted");
    this.name = "OptimizationAbortedError";
  }
}

/** Minimum trades required — matches Monte Carlo resample pool. */
export const MIN_OPTIMIZER_TRADES = 10;

/** Minimum strategies required for meaningful coordinate descent. */
export const MIN_OPTIMIZER_STRATEGIES = 2;

export interface OptimizerInputValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validate trade/strategy counts and weight bounds before running optimization.
 */
export function validateOptimizerInputs(
  tradeCount: number,
  strategyCount: number,
  constraints: Pick<WeightConstraints, "min" | "max" | "step">
): OptimizerInputValidation {
  const errors: string[] = [];

  if (tradeCount < MIN_OPTIMIZER_TRADES) {
    errors.push(
      `At least ${MIN_OPTIMIZER_TRADES} trades are required for Monte Carlo simulation`
    );
  }

  if (strategyCount < MIN_OPTIMIZER_STRATEGIES) {
    errors.push(
      `At least ${MIN_OPTIMIZER_STRATEGIES} strategies are required for optimization`
    );
  }

  if (constraints.step <= 0) {
    errors.push("Weight step must be greater than 0");
  } else if (constraints.max < constraints.min) {
    errors.push("Weight max must be greater than or equal to weight min");
  } else {
    const candidates = generateWeightCandidates({
      ...constraints,
      maxZeroFraction: 0,
    });
    if (candidates.length < 2) {
      errors.push(
        "Weight range must allow at least 2 different weight values (e.g. min 0, max 3)"
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

interface ObjectiveScore {
  medianMaxDrawdown: number;
  medianTotalReturn: number;
  probabilityOfProfit: number;
}

function formatDateKey(date: Date | undefined): string {
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

/**
 * Composite trade identity key for weight maps and export.
 * Format: dateClosed|timeClosed|strategy|legs|numContracts|pl
 */
export function tradeFingerprint(trade: Trade): TradeFingerprint {
  return [
    formatDateKey(trade.dateClosed),
    trade.timeClosed ?? "",
    trade.strategy ?? "",
    trade.legs ?? "",
    trade.numContracts,
    trade.pl,
  ].join("|");
}

/** Precomputed per-trade metadata reused across weight evaluations. */
interface TradeWeightPrep {
  fingerprints: TradeFingerprint[];
  closeTimeMs: number[];
  timeClosed: string[];
  initialCapital: number;
}

const YIELD_EVERY_N_TRADES = 25;

function getTradeWeight(
  trade: Trade,
  weights: TradeWeightMap,
  fingerprint?: TradeFingerprint
): number {
  return weights.get(fingerprint ?? tradeFingerprint(trade)) ?? 1;
}

function sortTradesChronologically(trades: Trade[]): Trade[] {
  return [...trades]
    .filter((t) => t.dateClosed)
    .sort((a, b) => {
      const cmp =
        new Date(a.dateClosed!).getTime() - new Date(b.dateClosed!).getTime();
      if (cmp !== 0) return cmp;
      return (a.timeClosed || "").localeCompare(b.timeClosed || "");
    });
}

function prepareTradeWeightPrep(trades: Trade[]): TradeWeightPrep {
  const fingerprints = trades.map((trade) => tradeFingerprint(trade));
  const closeTimeMs = trades.map((trade) =>
    trade.dateClosed ? trade.dateClosed.getTime() : 0
  );
  const timeClosed = trades.map((trade) => trade.timeClosed ?? "");
  const sortedOriginal = sortTradesChronologically(trades);
  const initialCapital =
    sortedOriginal.length > 0
      ? PortfolioStatsCalculator.calculateInitialCapital(sortedOriginal)
      : 0;

  return { fingerprints, closeTimeMs, timeClosed, initialCapital };
}

/**
 * Pre-scale trades before Monte Carlo simulation.
 * Weight 0 excludes the trade from the returned array.
 * numContracts is unchanged; dollar fields scale by weight.
 */
export function applyTradeWeights(
  trades: Trade[],
  weights: TradeWeightMap,
  prep: TradeWeightPrep = prepareTradeWeightPrep(trades)
): Trade[] {
  const scaledEntries: { index: number; scaledPl: number }[] = [];

  for (let index = 0; index < trades.length; index += 1) {
    const weight = weights.get(prep.fingerprints[index]!) ?? 1;
    if (weight === 0) continue;

    scaledEntries.push({
      index,
      scaledPl: trades[index]!.pl * weight,
    });
  }

  const sortedScaled = [...scaledEntries].sort((a, b) => {
    const cmp = prep.closeTimeMs[a.index]! - prep.closeTimeMs[b.index]!;
    if (cmp !== 0) return cmp;
    return prep.timeClosed[a.index]!.localeCompare(prep.timeClosed[b.index]!);
  });

  let runningEquity = prep.initialCapital;
  const fundsByIndex = new Map<number, number>();
  for (const entry of sortedScaled) {
    runningEquity += entry.scaledPl;
    fundsByIndex.set(entry.index, runningEquity);
  }

  return scaledEntries.map(({ index, scaledPl }) => {
    const trade = trades[index]!;
    const weight = weights.get(prep.fingerprints[index]!) ?? 1;
    return {
      ...trade,
      pl: scaledPl,
      openingCommissionsFees: trade.openingCommissionsFees * weight,
      closingCommissionsFees: trade.closingCommissionsFees * weight,
      marginReq: trade.marginReq * weight,
      maxLoss: trade.maxLoss !== undefined ? trade.maxLoss * weight : undefined,
      maxProfit:
        trade.maxProfit !== undefined ? trade.maxProfit * weight : undefined,
      fundsAtClose: fundsByIndex.get(index) ?? trade.fundsAtClose,
    };
  });
}

function isOnStep(value: number, min: number, step: number): boolean {
  const steps = Math.round((value - min) / step);
  const reconstructed = min + steps * step;
  return Math.abs(reconstructed - value) < 1e-9;
}

function strategyKey(strategy?: string): string {
  return strategy || "Unknown";
}

/**
 * Unique strategy names present in the trade set, sorted alphabetically.
 */
export function getStrategyNames(trades: Trade[]): string[] {
  const names = new Set(trades.map((trade) => strategyKey(trade.strategy)));
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/**
 * Aggregate per-strategy stats for the weights table.
 */
export function buildStrategySummaries(trades: Trade[]): StrategySummary[] {
  const byStrategy = new Map<string, StrategySummary>();

  for (const trade of trades) {
    const strategy = strategyKey(trade.strategy);
    const existing = byStrategy.get(strategy) ?? {
      strategy,
      tradeCount: 0,
      totalPl: 0,
      worstTradePl: Number.POSITIVE_INFINITY,
    };
    existing.tradeCount += 1;
    existing.totalPl += trade.pl;
    existing.worstTradePl = Math.min(existing.worstTradePl, trade.pl);
    byStrategy.set(strategy, existing);
  }

  return Array.from(byStrategy.values()).sort((a, b) =>
    a.strategy.localeCompare(b.strategy)
  );
}

function strategyWeightsToTradeWeights(
  trades: Trade[],
  strategyWeights: StrategyWeightMap,
  prep: TradeWeightPrep
): TradeWeightMap {
  const tradeWeights = new Map<TradeFingerprint, number>();
  for (let index = 0; index < trades.length; index += 1) {
    const strategy = strategyKey(trades[index]!.strategy);
    tradeWeights.set(
      prep.fingerprints[index]!,
      strategyWeights.get(strategy) ?? 1
    );
  }
  return tradeWeights;
}

/**
 * Scale all trades by their strategy's contract multiplier.
 * Weight 0 excludes every trade in that strategy from the resample pool.
 */
export function applyStrategyWeights(
  trades: Trade[],
  strategyWeights: StrategyWeightMap,
  prep: TradeWeightPrep = prepareTradeWeightPrep(trades)
): Trade[] {
  const tradeWeights = strategyWeightsToTradeWeights(trades, strategyWeights, prep);
  return applyTradeWeights(trades, tradeWeights, prep);
}

/**
 * Validate per-strategy weights against optimizer constraints.
 */
export function validateStrategyWeights(
  strategies: string[],
  weights: StrategyWeightMap,
  constraints: WeightConstraints
): ValidateWeightsResult {
  const errors: string[] = [];
  let nonZeroCount = 0;
  let zeroCount = 0;

  for (const strategy of strategies) {
    const weight = weights.get(strategy) ?? 1;

    if (weight < constraints.min || weight > constraints.max) {
      errors.push(
        `Weight ${weight} for ${strategy} is outside [${constraints.min}, ${constraints.max}]`
      );
    } else if (!isOnStep(weight, constraints.min, constraints.step)) {
      errors.push(
        `Weight ${weight} for ${strategy} is not on step ${constraints.step}`
      );
    }

    if (weight > 0) {
      nonZeroCount += 1;
    } else {
      zeroCount += 1;
    }
  }

  if (nonZeroCount === 0) {
    errors.push("At least one strategy must have a non-zero weight");
  }

  const maxZeros = Math.floor(strategies.length * constraints.maxZeroFraction);
  if (zeroCount > maxZeros) {
    errors.push(
      `${zeroCount} zero-weight strategies exceeds the cap of ${maxZeros} (${constraints.maxZeroFraction * 100}% of ${strategies.length})`
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate per-trade weights against optimizer constraints.
 * Shared by coordinate descent and manual weight editing.
 */
export function validateWeights(
  trades: Trade[],
  weights: TradeWeightMap,
  constraints: WeightConstraints
): ValidateWeightsResult {
  const errors: string[] = [];
  let nonZeroCount = 0;
  let zeroCount = 0;

  for (const trade of trades) {
    const weight = getTradeWeight(trade, weights);

    if (weight < constraints.min || weight > constraints.max) {
      errors.push(
        `Weight ${weight} for ${trade.legs} is outside [${constraints.min}, ${constraints.max}]`
      );
    } else if (!isOnStep(weight, constraints.min, constraints.step)) {
      errors.push(
        `Weight ${weight} for ${trade.legs} is not on step ${constraints.step}`
      );
    }

    if (weight > 0) {
      nonZeroCount += 1;
    } else {
      zeroCount += 1;
    }
  }

  if (nonZeroCount === 0) {
    errors.push("At least one trade must have a non-zero weight");
  }

  const maxZeros = Math.floor(trades.length * constraints.maxZeroFraction);
  if (zeroCount > maxZeros) {
    errors.push(
      `${zeroCount} zero-weight trades exceeds the cap of ${maxZeros} (${constraints.maxZeroFraction * 100}% of ${trades.length})`
    );
  }

  return { valid: errors.length === 0, errors };
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OptimizationAbortedError();
  }
}

function buildUniformWeights(trades: Trade[], weight: number): TradeWeightMap {
  const weights = new Map<TradeFingerprint, number>();
  for (const trade of trades) {
    weights.set(tradeFingerprint(trade), weight);
  }
  return weights;
}

function generateWeightCandidates(bounds: WeightConstraints): number[] {
  const candidates: number[] = [];
  const steps = Math.round((bounds.max - bounds.min) / bounds.step);
  for (let i = 0; i <= steps; i += 1) {
    candidates.push(bounds.min + i * bounds.step);
  }
  return candidates;
}

function scoreFromResult(result: MonteCarloResult): ObjectiveScore {
  return {
    medianMaxDrawdown: result.statistics.medianMaxDrawdown,
    medianTotalReturn: result.statistics.medianTotalReturn,
    probabilityOfProfit: result.statistics.probabilityOfProfit,
  };
}

function isCandidateBetter(
  candidate: ObjectiveScore,
  current: ObjectiveScore,
  epsilon: number
): boolean {
  if (candidate.medianMaxDrawdown < current.medianMaxDrawdown - epsilon) {
    return true;
  }
  if (candidate.medianMaxDrawdown > current.medianMaxDrawdown + epsilon) {
    return false;
  }
  if (candidate.medianTotalReturn > current.medianTotalReturn + epsilon) {
    return true;
  }
  if (candidate.medianTotalReturn < current.medianTotalReturn - epsilon) {
    return false;
  }
  return candidate.probabilityOfProfit > current.probabilityOfProfit + epsilon;
}

function sortTradesWorstLossFirst(trades: Trade[]): Trade[] {
  return [...trades].sort((a, b) => a.pl - b.pl);
}

function evaluateWeights(
  trades: Trade[],
  weights: TradeWeightMap,
  mcParams: Omit<MonteCarloParams, "numSimulations">,
  numSimulations: number,
  prep: TradeWeightPrep,
  randomSeed?: number
): MonteCarloResult {
  const scaledTrades = applyTradeWeights(trades, weights, prep);
  return runMonteCarloSimulation(scaledTrades, {
    ...mcParams,
    numSimulations,
    randomSeed: randomSeed ?? mcParams.randomSeed,
  });
}

function evaluateStrategyWeights(
  trades: Trade[],
  strategyWeights: StrategyWeightMap,
  mcParams: Omit<MonteCarloParams, "numSimulations">,
  numSimulations: number,
  prep: TradeWeightPrep,
  randomSeed?: number
): MonteCarloResult {
  const scaledTrades = applyStrategyWeights(trades, strategyWeights, prep);
  return runMonteCarloSimulation(scaledTrades, {
    ...mcParams,
    numSimulations,
    randomSeed: randomSeed ?? mcParams.randomSeed,
  });
}

function buildUniformStrategyWeights(
  strategies: string[],
  weight: number
): StrategyWeightMap {
  const weights = new Map<string, number>();
  for (const strategy of strategies) {
    weights.set(strategy, weight);
  }
  return weights;
}

function sortStrategiesWorstLossFirst(
  strategies: string[],
  trades: Trade[]
): string[] {
  const totals = new Map<string, number>();
  for (const trade of trades) {
    const strategy = strategyKey(trade.strategy);
    totals.set(strategy, (totals.get(strategy) ?? 0) + trade.pl);
  }
  return [...strategies].sort(
    (a, b) => (totals.get(a) ?? 0) - (totals.get(b) ?? 0)
  );
}

function emitProgress(
  onProgress: McDrawdownOptimizerParams["onProgress"],
  event: Omit<OptimizerProgressEvent, "tradeIndex" | "tradeCount"> & {
    strategyIndex?: number;
    strategyCount?: number;
  }
): void {
  onProgress?.({
    ...event,
    tradeIndex: event.strategyIndex,
    tradeCount: event.strategyCount,
  });
}

function isTrialWeightValid(
  currentWeight: number,
  candidateWeight: number,
  zeroCount: number,
  tradeCount: number,
  constraints: WeightConstraints,
  maxZeros: number
): boolean {
  if (
    candidateWeight < constraints.min ||
    candidateWeight > constraints.max ||
    !isOnStep(candidateWeight, constraints.min, constraints.step)
  ) {
    return false;
  }

  let nextZeroCount = zeroCount;
  if (currentWeight === 0) nextZeroCount -= 1;
  if (candidateWeight === 0) nextZeroCount += 1;

  if (tradeCount - nextZeroCount <= 0) return false;
  return nextZeroCount <= maxZeros;
}

/**
 * Coordinate-descent search for per-trade weights minimizing median max drawdown.
 * @deprecated Prefer optimizeStrategyWeights for the drawdown optimizer UI.
 */
export async function optimizeTradeWeights(
  options: McDrawdownOptimizerParams
): Promise<McDrawdownTradeOptimizerResult> {
  const {
    trades,
    mcParams,
    searchSimulations,
    finalSimulations,
    weightBounds,
    maxPasses,
    maxZeroFraction,
    epsilon,
    randomSeed,
    signal,
    onProgress,
    yieldToMain,
  } = options;

  const constraints: WeightConstraints = {
    ...weightBounds,
    maxZeroFraction,
  };

  const strategyNames = getStrategyNames(trades);
  const inputValidation = validateOptimizerInputs(
    trades.length,
    strategyNames.length,
    constraints
  );
  if (!inputValidation.valid) {
    throw new Error(inputValidation.errors.join("; "));
  }

  const seed = randomSeed ?? mcParams.randomSeed;
  const prep = prepareTradeWeightPrep(trades);
  const maxZeros = Math.floor(trades.length * maxZeroFraction);

  const baselineWeights = buildUniformWeights(trades, 1);
  const optimizedWeights = new Map(baselineWeights);
  let zeroCount = 0;

  checkAborted(signal);
  await yieldToMain?.();

  emitProgress(onProgress, {
    phase: "baseline",
    currentBestMdd: Number.POSITIVE_INFINITY,
  });

  const searchBaselineResult = evaluateWeights(
    trades,
    baselineWeights,
    mcParams,
    searchSimulations,
    prep,
    seed
  );
  const searchPhaseBaselineMdd = searchBaselineResult.statistics.medianMaxDrawdown;
  let currentBestScore = scoreFromResult(searchBaselineResult);
  let searchPhaseOptimizedMdd = searchPhaseBaselineMdd;

  emitProgress(onProgress, {
    phase: "search",
    pass: 0,
    maxPasses,
    strategyCount: trades.length,
    currentBestMdd: searchPhaseOptimizedMdd,
  });

  const visitOrder = sortTradesWorstLossFirst(trades);
  const candidates = generateWeightCandidates(constraints);

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    let passImproved = false;

    for (let tradeIndex = 0; tradeIndex < visitOrder.length; tradeIndex += 1) {
      checkAborted(signal);
      if (tradeIndex % YIELD_EVERY_N_TRADES === 0) {
        await yieldToMain?.();
      }

      const trade = visitOrder[tradeIndex]!;
      const fp = tradeFingerprint(trade);
      const currentWeight = optimizedWeights.get(fp) ?? 1;
      let bestWeight = currentWeight;
      let bestScore = currentBestScore;

      for (const candidateWeight of candidates) {
        if (candidateWeight === currentWeight) continue;
        if (
          !isTrialWeightValid(
            currentWeight,
            candidateWeight,
            zeroCount,
            trades.length,
            constraints,
            maxZeros
          )
        ) {
          continue;
        }

        checkAborted(signal);

        const trial = new Map(optimizedWeights);
        trial.set(fp, candidateWeight);
        const trialResult = evaluateWeights(
          trades,
          trial,
          mcParams,
          searchSimulations,
          prep,
          seed
        );
        const trialScore = scoreFromResult(trialResult);

        if (isCandidateBetter(trialScore, bestScore, epsilon)) {
          bestWeight = candidateWeight;
          bestScore = trialScore;
        }
      }

      if (bestWeight !== currentWeight) {
        if (currentWeight === 0) zeroCount -= 1;
        if (bestWeight === 0) zeroCount += 1;
        optimizedWeights.set(fp, bestWeight);
        currentBestScore = bestScore;
        searchPhaseOptimizedMdd = bestScore.medianMaxDrawdown;
        passImproved = true;
      }

      if (
        tradeIndex === visitOrder.length - 1 ||
        (tradeIndex + 1) % YIELD_EVERY_N_TRADES === 0
      ) {
        emitProgress(onProgress, {
          phase: "search",
          pass,
          maxPasses,
          strategyIndex: tradeIndex + 1,
          strategyCount: visitOrder.length,
          currentBestMdd: searchPhaseOptimizedMdd,
        });
      }
    }

    if (!passImproved) {
      break;
    }
  }

  checkAborted(signal);
  await yieldToMain?.();

  emitProgress(onProgress, {
    phase: "final",
    currentBestMdd: searchPhaseOptimizedMdd,
  });

  const baselineStats = evaluateWeights(
    trades,
    baselineWeights,
    mcParams,
    finalSimulations,
    prep,
    seed
  );
  const optimizedStats = evaluateWeights(
    trades,
    optimizedWeights,
    mcParams,
    finalSimulations,
    prep,
    seed
  );

  const improved = isCandidateBetter(
    scoreFromResult(optimizedStats),
    scoreFromResult(baselineStats),
    epsilon
  );

  return {
    baselineWeights,
    optimizedWeights,
    baselineStats,
    optimizedStats,
    improved,
    searchPhaseBaselineMdd,
    searchPhaseOptimizedMdd,
  };
}

/**
 * Coordinate-descent search for per-strategy weights minimizing median max drawdown.
 */
export async function optimizeStrategyWeights(
  options: McDrawdownOptimizerParams
): Promise<McDrawdownOptimizerResult> {
  const {
    trades,
    mcParams,
    searchSimulations,
    finalSimulations,
    weightBounds,
    maxPasses,
    maxZeroFraction,
    epsilon,
    randomSeed,
    signal,
    onProgress,
    yieldToMain,
  } = options;

  const constraints: WeightConstraints = {
    ...weightBounds,
    maxZeroFraction,
  };

  const strategies = getStrategyNames(trades);
  const inputValidation = validateOptimizerInputs(
    trades.length,
    strategies.length,
    constraints
  );
  if (!inputValidation.valid) {
    throw new Error(inputValidation.errors.join("; "));
  }

  const seed = randomSeed ?? mcParams.randomSeed;
  const prep = prepareTradeWeightPrep(trades);
  const maxZeros = Math.floor(strategies.length * maxZeroFraction);

  const baselineStrategyWeights = buildUniformStrategyWeights(strategies, 1);
  const optimizedStrategyWeights = new Map(baselineStrategyWeights);
  let zeroCount = 0;

  checkAborted(signal);
  await yieldToMain?.();

  emitProgress(onProgress, {
    phase: "baseline",
    currentBestMdd: Number.POSITIVE_INFINITY,
  });

  const searchBaselineResult = evaluateStrategyWeights(
    trades,
    baselineStrategyWeights,
    mcParams,
    searchSimulations,
    prep,
    seed
  );
  const searchPhaseBaselineMdd = searchBaselineResult.statistics.medianMaxDrawdown;
  let currentBestScore = scoreFromResult(searchBaselineResult);
  let searchPhaseOptimizedMdd = searchPhaseBaselineMdd;

  emitProgress(onProgress, {
    phase: "search",
    pass: 0,
    maxPasses,
    strategyCount: strategies.length,
    currentBestMdd: searchPhaseOptimizedMdd,
  });

  const visitOrder = sortStrategiesWorstLossFirst(strategies, trades);
  const candidates = generateWeightCandidates(constraints);

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    let passImproved = false;

    for (
      let strategyIndex = 0;
      strategyIndex < visitOrder.length;
      strategyIndex += 1
    ) {
      checkAborted(signal);
      if (strategyIndex % YIELD_EVERY_N_TRADES === 0) {
        await yieldToMain?.();
      }

      const strategy = visitOrder[strategyIndex]!;
      const currentWeight = optimizedStrategyWeights.get(strategy) ?? 1;
      let bestWeight = currentWeight;
      let bestScore = currentBestScore;

      for (const candidateWeight of candidates) {
        if (candidateWeight === currentWeight) continue;
        if (
          !isTrialWeightValid(
            currentWeight,
            candidateWeight,
            zeroCount,
            strategies.length,
            constraints,
            maxZeros
          )
        ) {
          continue;
        }

        checkAborted(signal);

        const trial = new Map(optimizedStrategyWeights);
        trial.set(strategy, candidateWeight);
        const trialResult = evaluateStrategyWeights(
          trades,
          trial,
          mcParams,
          searchSimulations,
          prep,
          seed
        );
        const trialScore = scoreFromResult(trialResult);

        if (isCandidateBetter(trialScore, bestScore, epsilon)) {
          bestWeight = candidateWeight;
          bestScore = trialScore;
        }
      }

      if (bestWeight !== currentWeight) {
        if (currentWeight === 0) zeroCount -= 1;
        if (bestWeight === 0) zeroCount += 1;
        optimizedStrategyWeights.set(strategy, bestWeight);
        currentBestScore = bestScore;
        searchPhaseOptimizedMdd = bestScore.medianMaxDrawdown;
        passImproved = true;
      }

      if (
        strategyIndex === visitOrder.length - 1 ||
        (strategyIndex + 1) % YIELD_EVERY_N_TRADES === 0
      ) {
        emitProgress(onProgress, {
          phase: "search",
          pass,
          maxPasses,
          strategyIndex: strategyIndex + 1,
          strategyCount: visitOrder.length,
          currentBestMdd: searchPhaseOptimizedMdd,
        });
      }
    }

    if (!passImproved) {
      break;
    }
  }

  checkAborted(signal);
  await yieldToMain?.();

  emitProgress(onProgress, {
    phase: "final",
    currentBestMdd: searchPhaseOptimizedMdd,
  });

  const baselineStats = evaluateStrategyWeights(
    trades,
    baselineStrategyWeights,
    mcParams,
    finalSimulations,
    prep,
    seed
  );
  const optimizedStats = evaluateStrategyWeights(
    trades,
    optimizedStrategyWeights,
    mcParams,
    finalSimulations,
    prep,
    seed
  );

  const improved = isCandidateBetter(
    scoreFromResult(optimizedStats),
    scoreFromResult(baselineStats),
    epsilon
  );

  return {
    baselineStrategyWeights,
    optimizedStrategyWeights,
    baselineStats,
    optimizedStats,
    improved,
    searchPhaseBaselineMdd,
    searchPhaseOptimizedMdd,
  };
}

export interface RevalidateCustomStrategyWeightsParams {
  trades: Trade[];
  strategyWeights: StrategyWeightMap;
  mcParams: Omit<MonteCarloParams, "numSimulations">;
  finalSimulations: number;
  constraints: WeightConstraints;
  randomSeed?: number;
}

/**
 * Re-run Monte Carlo at the final simulation count for user-edited strategy weights.
 */
export function revalidateCustomStrategyWeights(
  options: RevalidateCustomStrategyWeightsParams
): MonteCarloResult {
  const {
    trades,
    strategyWeights,
    mcParams,
    finalSimulations,
    constraints,
    randomSeed,
  } = options;

  const strategies = getStrategyNames(trades);
  const validation = validateStrategyWeights(
    strategies,
    strategyWeights,
    constraints
  );
  if (!validation.valid) {
    throw new Error(validation.errors.join("; "));
  }

  const prep = prepareTradeWeightPrep(trades);
  return evaluateStrategyWeights(
    trades,
    strategyWeights,
    mcParams,
    finalSimulations,
    prep,
    randomSeed
  );
}

export interface RevalidateCustomWeightsParams {
  trades: Trade[];
  weights: TradeWeightMap;
  mcParams: Omit<MonteCarloParams, "numSimulations">;
  finalSimulations: number;
  constraints: WeightConstraints;
  randomSeed?: number;
}

/**
 * Re-run Monte Carlo at the final simulation count for user-edited weights.
 * Throws when weights fail optimizer constraints.
 */
export function revalidateCustomWeights(
  options: RevalidateCustomWeightsParams
): MonteCarloResult {
  const { trades, weights, mcParams, finalSimulations, constraints, randomSeed } =
    options;

  const validation = validateWeights(trades, weights, constraints);
  if (!validation.valid) {
    throw new Error(validation.errors.join("; "));
  }

  const prep = prepareTradeWeightPrep(trades);
  return evaluateWeights(
    trades,
    weights,
    mcParams,
    finalSimulations,
    prep,
    randomSeed
  );
}

function formatTradeDate(date: Date | undefined): string {
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

/**
 * Build CSV lines for per-trade weight export (header + one row per trade).
 */
export function buildDrawdownOptimizerWeightsCsv(
  trades: Trade[],
  weights: TradeWeightMap
): string[] {
  const header = toCsvRow([
    "fingerprint",
    "dateClosed",
    "timeClosed",
    "strategy",
    "legs",
    "numContracts",
    "pl",
    "weight",
  ]);

  const rows = trades.map((trade) => {
    const fp = tradeFingerprint(trade);
    const weight = getTradeWeight(trade, weights);
    return toCsvRow([
      fp,
      formatTradeDate(trade.dateClosed),
      trade.timeClosed ?? "",
      trade.strategy ?? "",
      trade.legs ?? "",
      trade.numContracts,
      trade.pl,
      weight,
    ]);
  });

  return [header, ...rows];
}

/**
 * Build CSV lines for per-strategy weight export.
 */
export function buildDrawdownOptimizerStrategyWeightsCsv(
  summaries: StrategySummary[],
  strategyWeights: StrategyWeightMap
): string[] {
  const header = toCsvRow([
    "strategy",
    "tradeCount",
    "totalPl",
    "worstTradePl",
    "weight",
  ]);

  const rows = summaries.map((summary) =>
    toCsvRow([
      summary.strategy,
      summary.tradeCount,
      summary.totalPl,
      summary.worstTradePl,
      strategyWeights.get(summary.strategy) ?? 1,
    ])
  );

  return [header, ...rows];
}

export interface SerializedDrawdownOptimizerResult {
  baselineStrategyWeights: Record<string, number>;
  optimizedStrategyWeights: Record<string, number>;
  customStrategyWeights?: Record<string, number>;
  baselineStats: MonteCarloResult;
  optimizedStats: MonteCarloResult;
  customStats?: MonteCarloResult;
  improved: boolean;
  searchPhaseBaselineMdd: number;
  searchPhaseOptimizedMdd: number;
  exportedAt: string;
}

/**
 * Serialize optimization result for JSON export (Maps → plain objects).
 */
export function serializeDrawdownOptimizerResult(
  result: McDrawdownOptimizerResult,
  extras?: {
    customStrategyWeights?: StrategyWeightMap;
    customStats?: MonteCarloResult;
  }
): SerializedDrawdownOptimizerResult {
  const serialized: SerializedDrawdownOptimizerResult = {
    baselineStrategyWeights: Object.fromEntries(result.baselineStrategyWeights),
    optimizedStrategyWeights: Object.fromEntries(
      result.optimizedStrategyWeights
    ),
    baselineStats: result.baselineStats,
    optimizedStats: result.optimizedStats,
    improved: result.improved,
    searchPhaseBaselineMdd: result.searchPhaseBaselineMdd,
    searchPhaseOptimizedMdd: result.searchPhaseOptimizedMdd,
    exportedAt: new Date().toISOString(),
  };

  if (extras?.customStrategyWeights) {
    serialized.customStrategyWeights = Object.fromEntries(
      extras.customStrategyWeights
    );
  }
  if (extras?.customStats) {
    serialized.customStats = extras.customStats;
  }

  return serialized;
}
