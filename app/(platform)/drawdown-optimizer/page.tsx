"use client";

import { DrawdownOptimizerResultsPanel } from "@/components/drawdown-optimizer/drawdown-optimizer-results-panel";
import { FieldExplainer } from "@/components/drawdown-optimizer/field-explainer";
import { MultiSelect } from "@/components/multi-select";
import { NoActiveBlock } from "@/components/no-active-block";
import { TradingFrequencyCard } from "@/components/risk-simulator/trading-frequency-card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildDrawdownOptimizerStrategyWeightsCsv,
  buildStrategySummaries,
  DRAWDOWN_OPTIMIZER_DEFAULTS,
  downloadCsv,
  downloadJson,
  estimateTradesPerYear,
  generateExportFilename,
  getBlock,
  getDailyLogsByBlock,
  getStrategyNames,
  getTradesByBlockWithOptions,
  optimizeStrategyWeights,
  OptimizationAbortedError,
  percentageToTrades,
  PortfolioStatsCalculator,
  revalidateCustomStrategyWeights,
  serializeDrawdownOptimizerResult,
  timeToTrades,
  validateStrategyWeights,
  validateOptimizerInputs,
  cn,
} from "@tradeblocks/lib";
import type {
  DailyLogEntry,
  McDrawdownOptimizerResult,
  MonteCarloParams,
  MonteCarloResult,
  OptimizerProgressEvent,
  StrategySummary,
  StrategyWeightMap,
  Trade,
  WeightConstraints,
} from "@tradeblocks/lib";
import { useBlockStore } from "@tradeblocks/lib/stores";
import { AlertTriangle, Download, Loader2, Square, Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const LARGE_STRATEGY_COUNT_WARNING = 25;

function formatCurrency(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatPctDecimal(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatWeightDelta(weight: number): string {
  const delta = weight - 1;
  if (delta === 0) return "0";
  return delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
}

function isWeightOnStep(value: number, min: number, step: number): boolean {
  const steps = Math.round((value - min) / step);
  return Math.abs(min + steps * step - value) < 1e-9;
}

function getRowWeightErrors(
  weight: number,
  constraints: Pick<WeightConstraints, "min" | "max" | "step">
): string[] {
  const errors: string[] = [];
  if (weight < constraints.min || weight > constraints.max) {
    errors.push(`Must be between ${constraints.min} and ${constraints.max}`);
  } else if (!isWeightOnStep(weight, constraints.min, constraints.step)) {
    errors.push(`Must use step ${constraints.step}`);
  }
  return errors;
}

export default function DrawdownOptimizerPage() {
  const { activeBlockId, blocks, setBlockSwitchLocked } = useBlockStore();
  const activeBlock = blocks.find((b) => b.id === activeBlockId);

  const [trades, setTrades] = useState<Trade[]>([]);
  const [dailyLogs, setDailyLogs] = useState<DailyLogEntry[]>([]);
  const [selectedStrategies, setSelectedStrategies] = useState<string[]>([]);
  const [initialCapital, setInitialCapital] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.preloadInitialCapital
  );
  const [tradesPerYear, setTradesPerYear] = useState(252);

  const [simulationPeriodValue, setSimulationPeriodValue] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.simulationPeriodValue
  );
  const simulationPeriodUnit = DRAWDOWN_OPTIMIZER_DEFAULTS.simulationPeriodUnit;
  const [resamplePercentage, setResamplePercentage] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.resamplePercentage
  );
  const [searchSimulations, setSearchSimulations] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.searchSimulations
  );
  const [finalSimulations, setFinalSimulations] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.finalSimulations
  );
  const [useFixedSeed, setUseFixedSeed] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.useFixedSeed
  );
  const [seedValue, setSeedValue] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.seedValue
  );
  const [worstCaseEnabled, setWorstCaseEnabled] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.worstCaseEnabled
  );
  const [worstCasePercentage, setWorstCasePercentage] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.worstCasePercentage
  );
  const [worstCaseMode, setWorstCaseMode] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.worstCaseMode
  );
  const [worstCaseBasedOn, setWorstCaseBasedOn] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.worstCaseBasedOn
  );
  const [worstCaseSizing, setWorstCaseSizing] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.worstCaseSizing
  );
  const [weightMin, setWeightMin] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.weightMin
  );
  const [weightMax, setWeightMax] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.weightMax
  );
  const [weightStep, setWeightStep] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.weightStep
  );
  const [useFractionalWeights, setUseFractionalWeights] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.useFractionalWeights
  );
  const [maxPasses, setMaxPasses] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.maxPasses
  );
  const [maxZeroFraction, setMaxZeroFraction] = useState(
    DRAWDOWN_OPTIMIZER_DEFAULTS.maxZeroFraction
  );

  const effectiveWeightStep = useFractionalWeights ? weightStep : 1;

  const [isOptimizing, setIsOptimizing] = useState(false);
  const [isRevalidating, setIsRevalidating] = useState(false);
  const [optimizationResult, setOptimizationResult] =
    useState<McDrawdownOptimizerResult | null>(null);
  const [editedWeights, setEditedWeights] = useState<StrategyWeightMap | null>(
    null
  );
  const [customStats, setCustomStats] = useState<MonteCarloResult | null>(null);
  const [hasRevalidated, setHasRevalidated] = useState(false);
  const [progress, setProgress] = useState<OptimizerProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  const handleOptimizerProgress = useCallback(
    (event: OptimizerProgressEvent) => {
      const strategyIndex = event.strategyIndex ?? event.tradeIndex ?? 0;
      const strategyCount = event.strategyCount ?? event.tradeCount ?? 0;
      const shouldUpdate =
        event.phase !== "search" ||
        strategyIndex === 0 ||
        strategyIndex % 5 === 0 ||
        strategyIndex === strategyCount;
      if (!shouldUpdate) return;
      setProgress(event);
    },
    []
  );

  const availableStrategies = useMemo(() => {
    const strategies = new Set(trades.map((t) => t.strategy).filter(Boolean));
    return Array.from(strategies);
  }, [trades]);

  const strategyOptions = useMemo(
    () =>
      availableStrategies.map((strategy) => ({
        label: strategy,
        value: strategy,
      })),
    [availableStrategies]
  );

  const filteredTrades = useMemo(() => {
    if (selectedStrategies.length === 0) return trades;
    const selected = new Set(selectedStrategies);
    return trades.filter((trade) => selected.has(trade.strategy || ""));
  }, [selectedStrategies, trades]);

  const optimizationStrategies = useMemo(
    () => getStrategyNames(filteredTrades),
    [filteredTrades]
  );

  const strategySummaries = useMemo(
    () => buildStrategySummaries(filteredTrades),
    [filteredTrades]
  );

  const calculatedTradesPerYear = useMemo(() => {
    if (trades.length === 0) return 252;
    return estimateTradesPerYear(trades, 252);
  }, [trades]);

  const frequencyTradesPerYear = useMemo(() => {
    if (filteredTrades.length === 0) return tradesPerYear;
    if (filteredTrades.length !== trades.length) {
      return estimateTradesPerYear(filteredTrades, tradesPerYear);
    }
    return calculatedTradesPerYear > 0 ? calculatedTradesPerYear : tradesPerYear;
  }, [filteredTrades, trades.length, tradesPerYear, calculatedTradesPerYear]);

  const calculatedInitialCapital = useMemo(() => {
    if (trades.length === 0) {
      return DRAWDOWN_OPTIMIZER_DEFAULTS.preloadInitialCapital;
    }
    const capital = PortfolioStatsCalculator.calculateInitialCapital(
      trades,
      dailyLogs.length > 0 ? dailyLogs : undefined
    );
    return capital > 0
      ? capital
      : DRAWDOWN_OPTIMIZER_DEFAULTS.preloadInitialCapital;
  }, [trades, dailyLogs]);


  const simulationLength = useMemo(() => {
    const effectiveTradesPerYear =
      filteredTrades.length !== trades.length
        ? estimateTradesPerYear(filteredTrades, tradesPerYear)
        : tradesPerYear;
    return Math.max(
      1,
      timeToTrades(
        simulationPeriodValue,
        simulationPeriodUnit,
        effectiveTradesPerYear
      )
    );
  }, [
    filteredTrades,
    trades.length,
    tradesPerYear,
    simulationPeriodUnit,
    simulationPeriodValue,
  ]);

  const resampleWindow = useMemo(() => {
    if (resamplePercentage === 100) return undefined;
    return percentageToTrades(resamplePercentage, filteredTrades.length);
  }, [filteredTrades.length, resamplePercentage]);

  const clearResults = useCallback(() => {
    setOptimizationResult(null);
    setEditedWeights(null);
    setCustomStats(null);
    setHasRevalidated(false);
    setProgress(null);
    setError(null);
  }, []);

  const weightConstraints = useMemo<WeightConstraints>(
    () => ({
      min: weightMin,
      max: weightMax,
      step: effectiveWeightStep,
      maxZeroFraction,
    }),
    [weightMin, weightMax, effectiveWeightStep, maxZeroFraction]
  );

  const weightValidation = useMemo(() => {
    if (!editedWeights || optimizationStrategies.length === 0) {
      return { valid: true, errors: [] as string[] };
    }
    return validateStrategyWeights(
      optimizationStrategies,
      editedWeights,
      weightConstraints
    );
  }, [editedWeights, optimizationStrategies, weightConstraints]);

  const optimizerInputValidation = useMemo(
    () =>
      validateOptimizerInputs(
        filteredTrades.length,
        optimizationStrategies.length,
        {
          min: weightMin,
          max: weightMax,
          step: effectiveWeightStep,
        }
      ),
    [
      filteredTrades.length,
      optimizationStrategies.length,
      weightMin,
      weightMax,
      effectiveWeightStep,
    ]
  );

  const canRunOptimization =
    filteredTrades.length > 0 && optimizerInputValidation.valid;

  useEffect(() => {
    if (optimizationResult) {
      setEditedWeights(new Map(optimizationResult.optimizedStrategyWeights));
      setCustomStats(null);
      setHasRevalidated(false);
    }
  }, [optimizationResult]);

  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      if (!activeBlockId) {
        if (!cancelled) {
          setTrades([]);
          setDailyLogs([]);
        }
        return;
      }

      try {
        const processedBlock = await getBlock(activeBlockId);
        const combineLegGroups =
          processedBlock?.analysisConfig?.combineLegGroups ?? false;

        const [loadedTrades, loadedDailyLogs] = await Promise.all([
          getTradesByBlockWithOptions(activeBlockId, { combineLegGroups }),
          getDailyLogsByBlock(activeBlockId),
        ]);

        if (!cancelled) {
          setTrades(loadedTrades);
          setDailyLogs(loadedDailyLogs);
        }
      } catch (loadError) {
        console.error("Failed to load block data:", loadError);
        if (!cancelled) {
          setTrades([]);
          setDailyLogs([]);
        }
      }
    };

    abortControllerRef.current?.abort();
    clearResults();
    loadData();

    return () => {
      cancelled = true;
    };
  }, [activeBlockId, clearResults]);

  useEffect(() => {
    if (trades.length > 0) {
      setTradesPerYear(
        calculatedTradesPerYear > 0 ? calculatedTradesPerYear : 252
      );
      setInitialCapital(calculatedInitialCapital);
    }
  }, [calculatedInitialCapital, calculatedTradesPerYear, trades.length]);

  useEffect(() => {
    setBlockSwitchLocked(isOptimizing);
    return () => setBlockSwitchLocked(false);
  }, [isOptimizing, setBlockSwitchLocked]);

  const invalidationKey = useMemo(
    () =>
      JSON.stringify({
        activeBlockId,
        selectedStrategies,
        initialCapital,
        simulationLength,
        resamplePercentage,
        searchSimulations,
        finalSimulations,
        useFixedSeed,
        seedValue,
        worstCaseEnabled,
        worstCasePercentage,
        worstCaseMode,
        worstCaseBasedOn,
        worstCaseSizing,
        weightMin,
        weightMax,
        effectiveWeightStep,
        useFractionalWeights,
        maxPasses,
        maxZeroFraction,
      }),
    [
      activeBlockId,
      selectedStrategies,
      initialCapital,
      simulationLength,
      resamplePercentage,
      searchSimulations,
      finalSimulations,
      useFixedSeed,
      seedValue,
      worstCaseEnabled,
      worstCasePercentage,
      worstCaseMode,
      worstCaseBasedOn,
      worstCaseSizing,
      weightMin,
      weightMax,
      effectiveWeightStep,
      useFractionalWeights,
      maxPasses,
      maxZeroFraction,
    ]
  );


  const resultsKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      optimizationResult &&
      resultsKeyRef.current &&
      resultsKeyRef.current !== invalidationKey
    ) {
      clearResults();
    }
  }, [invalidationKey, optimizationResult, clearResults]);

  const buildMcParams = useCallback((): Omit<MonteCarloParams, "numSimulations"> => {
    const effectiveTradesPerYear =
      filteredTrades.length !== trades.length
        ? estimateTradesPerYear(filteredTrades, tradesPerYear)
        : tradesPerYear;

    return {
      simulationLength,
      resampleWindow,
      resampleMethod: DRAWDOWN_OPTIMIZER_DEFAULTS.resampleMethod,
      initialCapital,
      tradesPerYear: effectiveTradesPerYear,
      randomSeed: useFixedSeed ? seedValue : undefined,
      normalizeTo1Lot: DRAWDOWN_OPTIMIZER_DEFAULTS.normalizeTo1Lot,
      worstCaseEnabled,
      worstCasePercentage,
      worstCaseMode,
      worstCaseBasedOn,
      worstCaseSizing,
    };
  }, [
    filteredTrades,
    trades.length,
    tradesPerYear,
    simulationLength,
    resampleWindow,
    initialCapital,
    useFixedSeed,
    seedValue,
    worstCaseEnabled,
    worstCasePercentage,
    worstCaseMode,
    worstCaseBasedOn,
    worstCaseSizing,
  ]);


  const runOptimization = async () => {
    if (!activeBlockId || filteredTrades.length === 0) {
      setError("No active block or trades available");
      return;
    }

    if (!optimizerInputValidation.valid) {
      setError(optimizerInputValidation.errors.join("; "));
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsOptimizing(true);
    setError(null);
    clearResults();

    try {
      await new Promise((resolve) => setTimeout(resolve, 16));

      const result = await optimizeStrategyWeights({
        trades: filteredTrades,
        mcParams: buildMcParams(),
        searchSimulations,
        finalSimulations,
        weightBounds: {
          min: weightMin,
          max: weightMax,
          step: effectiveWeightStep,
          maxZeroFraction,
        },

        maxPasses,
        maxZeroFraction,
        epsilon: 0.001,
        randomSeed: useFixedSeed ? seedValue : undefined,
        signal: controller.signal,
        onProgress: handleOptimizerProgress,
        yieldToMain: () => new Promise((resolve) => setTimeout(resolve, 16)),
      });

      resultsKeyRef.current = invalidationKey;
      setOptimizationResult(result);
      setEditedWeights(new Map(result.optimizedStrategyWeights));
      setCustomStats(null);
      setHasRevalidated(false);
    } catch (runError) {
      if (runError instanceof OptimizationAbortedError) {
        return;
      }
      setError(
        runError instanceof Error ? runError.message : "Optimization failed"
      );
    } finally {
      setIsOptimizing(false);
      abortControllerRef.current = null;
      setProgress(null);
    }
  };

  const cancelOptimization = () => {
    abortControllerRef.current?.abort();
  };

  const handleWeightChange = (strategy: string, rawValue: string) => {
    if (!editedWeights) return;
    const parsed = Number(rawValue);
    const weight = Number.isFinite(parsed) ? parsed : 0;
    const next = new Map(editedWeights);
    next.set(strategy, weight);
    setEditedWeights(next);
    setCustomStats(null);
  };

  const runRevalidate = async () => {
    if (!editedWeights || !weightValidation.valid || filteredTrades.length < 10) {
      return;
    }

    setIsRevalidating(true);
    setError(null);

    try {
      await new Promise((resolve) => setTimeout(resolve, 16));

      const stats = revalidateCustomStrategyWeights({
        trades: filteredTrades,
        strategyWeights: editedWeights,
        mcParams: buildMcParams(),
        finalSimulations,
        constraints: weightConstraints,
        randomSeed: useFixedSeed ? seedValue : undefined,
      });

      setCustomStats(stats);
      setHasRevalidated(true);
    } catch (revalidateError) {
      setError(
        revalidateError instanceof Error
          ? revalidateError.message
          : "Re-validation failed"
      );
    } finally {
      setIsRevalidating(false);
    }
  };

  const exportWeightsCsv = () => {
    if (!activeBlock || !editedWeights) return;
    const lines = buildDrawdownOptimizerStrategyWeightsCsv(
      strategySummaries,
      editedWeights
    );
    downloadCsv(
      lines,
      generateExportFilename(activeBlock.name, "drawdown-optimizer-weights", "csv")
    );
  };

  const exportResultJson = () => {
    if (!activeBlock || !optimizationResult) return;
    const payload = serializeDrawdownOptimizerResult(optimizationResult, {
      customStrategyWeights:
        hasRevalidated && editedWeights ? editedWeights : undefined,
      customStats: customStats ?? undefined,
    });
    downloadJson(
      payload,
      generateExportFilename(activeBlock.name, "drawdown-optimizer", "json")
    );
  };

  const handleStrategyFilterChange = (values: string[]) => {
    if (optimizationResult) {
      clearResults();
    }
    setSelectedStrategies(values);
  };

  if (!activeBlockId) {
    return (
      <NoActiveBlock description="Please select a block from the sidebar to optimize per-strategy sizing for drawdown." />
    );
  }

  const showLargeStrategyWarning =
    optimizationStrategies.length > LARGE_STRATEGY_COUNT_WARNING;

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Drawdown Optimizer
          </h1>
          <FieldExplainer
            iconSize="md"
            title="Drawdown Optimizer"
            summary="Find per-strategy contract multipliers that minimize median max drawdown over Monte Carlo simulations."
            details="The optimizer adjusts one weight per strategy (scaling all trades in that strategy together) using coordinate descent. It searches for lower drawdown profiles while a final validation run compares baseline and optimized weights at higher simulation counts."
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {activeBlock?.name ?? "Active block"} — per-strategy contract multipliers
          to minimize median max drawdown via Monte Carlo simulation.
        </p>
      </div>

      {!canRunOptimization && filteredTrades.length > 0 ? (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            {optimizerInputValidation.errors.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        </div>
      ) : null}

      {showLargeStrategyWarning ? (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <p>
            This block has {optimizationStrategies.length} strategies in the
            optimization universe ({filteredTrades.length} trades). Large
            strategy counts may take several minutes on the main thread — you
            can cancel at any time.
          </p>
        </div>
      ) : null}

      <TradingFrequencyCard
        trades={filteredTrades}
        tradesPerYear={frequencyTradesPerYear}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              Initial Capital
              <FieldExplainer
                title="Initial Capital"
                summary="Starting portfolio value from which all simulations begin."
                details="This value is auto-calculated from your block when data loads. Adjust it to simulate different account sizes. Monte Carlo applies your weighted trade history to this starting balance when projecting drawdowns and returns."
              />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Label htmlFor="initial-capital" className="sr-only">
              Initial capital
            </Label>
            <Input
              id="initial-capital"
              type="number"
              min={0}
              step={1000}
              value={initialCapital}
              disabled={isOptimizing}
              onChange={(e) => {
                clearResults();
                setInitialCapital(Number(e.target.value));
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              Strategy Filter
              <FieldExplainer
                title="Strategy Filter"
                summary="Choose which strategies are included in the optimization universe."
                details="Leave empty to optimize all strategies in the block. Selecting specific strategies limits the search to that subset. Changing the filter clears existing results so you always compare runs on the same universe."
              />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <MultiSelect
              options={strategyOptions}
              onValueChange={handleStrategyFilterChange}
              placeholder="All strategies"
              maxCount={3}
              className="w-full"
              disabled={isOptimizing}
            />
          </CardContent>
        </Card>
      </div>

      <Accordion type="single" collapsible>
        <AccordionItem value="advanced">
          <AccordionTrigger>Advanced settings</AccordionTrigger>
          <AccordionContent>
            <div className="grid gap-4 pt-2 md:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="sim-period">Simulation period (months)</Label>
                  <FieldExplainer
                    title="Simulation Period"
                    summary="How far into the future to project portfolio performance."
                    details="The optimizer converts months to a trade count using your historical trading frequency. Shorter periods focus on near-term drawdown risk; longer periods compound uncertainty. Default is 1 month."
                  />
                </div>
                <Input
                  id="sim-period"
                  type="number"
                  min={1}
                  value={simulationPeriodValue}
                  disabled={isOptimizing}
                  onChange={(e) => {
                    clearResults();
                    setSimulationPeriodValue(Number(e.target.value));
                  }}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="resample-pct">Resample window (%)</Label>
                  <FieldExplainer
                    title="Resample Window"
                    summary="Percentage of historical trades used when building each simulation."
                    details="Set to 100% to use your entire trade history, or reduce to focus on recent trades. For example, 50% uses only the most recent half of trades. Useful when strategy behavior or market conditions have shifted."
                  />
                </div>
                <Input
                  id="resample-pct"
                  type="number"
                  min={10}
                  max={100}
                  value={resamplePercentage}
                  disabled={isOptimizing}
                  onChange={(e) => {
                    clearResults();
                    setResamplePercentage(Number(e.target.value));
                  }}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="search-sims">Search simulations</Label>
                  <FieldExplainer
                    title="Search Simulations"
                    summary="Monte Carlo paths used during coordinate descent search."
                    details="Lower counts run faster but produce noisier median drawdown estimates when comparing candidate weights. The default of 2,000 balances speed and stability while the optimizer evaluates many weight combinations."
                  />
                </div>
                <Input
                  id="search-sims"
                  type="number"
                  min={100}
                  value={searchSimulations}
                  disabled={isOptimizing}
                  onChange={(e) => {
                    clearResults();
                    setSearchSimulations(Number(e.target.value));
                  }}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="final-sims">Final simulations</Label>
                  <FieldExplainer
                    title="Final Simulations"
                    summary="High-precision Monte Carlo runs for baseline and optimized comparison."
                    details="After search completes, baseline (all weights 1.0) and optimized weights are each re-simulated at this count. Re-validate also uses this setting for custom weight comparisons. Default is 10,000."
                  />
                </div>
                <Input
                  id="final-sims"
                  type="number"
                  min={100}
                  value={finalSimulations}
                  disabled={isOptimizing}
                  onChange={(e) => {
                    clearResults();
                    setFinalSimulations(Number(e.target.value));
                  }}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="max-passes">Max passes</Label>
                  <FieldExplainer
                    title="Max Passes"
                    summary="Number of coordinate descent rounds through all strategies."
                    details="Each pass visits every strategy once, starting with the worst aggregate P/L strategies. The optimizer tries candidate weights at each stop and keeps improvements. More passes may find better weights but increase runtime."
                  />
                </div>
                <Input
                  id="max-passes"
                  type="number"
                  min={1}
                  max={20}
                  value={maxPasses}
                  disabled={isOptimizing}
                  onChange={(e) => {
                    clearResults();
                    setMaxPasses(Number(e.target.value));
                  }}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="zero-cap">Max zero-weight fraction</Label>
                  <FieldExplainer
                    title="Max Zero-Weight Fraction"
                    summary="Limits how many strategies can be set to weight 0."
                    details="Weight 0 removes all trades in that strategy from the resample pool. At least one strategy must stay non-zero. Default caps zero-weight strategies at 10% of the optimization universe."
                  />
                </div>
                <Input
                  id="zero-cap"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={maxZeroFraction}
                  disabled={isOptimizing}
                  onChange={(e) => {
                    clearResults();
                    setMaxZeroFraction(Number(e.target.value));
                  }}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="weight-min">Weight min</Label>
                  <FieldExplainer
                    title="Weight Minimum"
                    summary="Lowest contract multiplier the optimizer may assign per strategy."
                    details="A weight of 0 excludes that strategy's trades from Monte Carlo resampling. Min and max must allow at least two distinct values (for example, 0 and 3, not both 1)."
                  />
                </div>
                <Input
                  id="weight-min"
                  type="number"
                  value={weightMin}
                  disabled={isOptimizing}
                  onChange={(e) => {
                    clearResults();
                    setWeightMin(Number(e.target.value));
                  }}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="weight-max">Weight max</Label>
                  <FieldExplainer
                    title="Weight Maximum"
                    summary="Highest contract multiplier the optimizer may assign per strategy."
                    details="Scales P/L, commissions, margin, and max loss for every trade in that strategy. Higher caps allow larger size increases but expand the search space and runtime."
                  />
                </div>
                <Input
                  id="weight-max"
                  type="number"
                  value={weightMax}
                  disabled={isOptimizing}
                  onChange={(e) => {
                    clearResults();
                    setWeightMax(Number(e.target.value));
                  }}
                />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor="fractional-weights">Fractional weight steps</Label>
                  <FieldExplainer
                    title="Fractional Weight Steps"
                    summary="Allow non-integer multipliers such as 0.5 or 1.5."
                    details="Off by default — the optimizer uses whole-number steps of 1. Enable when you need finer sizing control; combine with the weight step setting below."
                  />
                </div>
                <Switch
                  id="fractional-weights"
                  checked={useFractionalWeights}
                  disabled={isOptimizing}
                  onCheckedChange={(checked) => {
                    clearResults();
                    setUseFractionalWeights(checked);
                    if (!checked) {
                      setWeightStep(DRAWDOWN_OPTIMIZER_DEFAULTS.weightStep);
                    }
                  }}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="weight-step">Weight step</Label>
                  <FieldExplainer
                    title="Weight Step"
                    summary="Grid spacing between candidate weights during search."
                    details="Only applies when fractional weights are enabled. The optimizer tries weights at min, min+step, min+2×step, and so on up to max. Smaller steps explore more candidates but increase runtime."
                  />
                </div>
                <Input
                  id="weight-step"
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={useFractionalWeights ? weightStep : 1}
                  disabled={isOptimizing || !useFractionalWeights}
                  onChange={(e) => {
                    clearResults();
                    setWeightStep(Number(e.target.value));
                  }}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="worst-case-pct">Worst-case %</Label>
                  <FieldExplainer
                    title="Worst-Case Percentage"
                    contentWidth="w-72"
                    details="Controls how many max-loss trades are created. In pool mode they are added to the resample pool; in guarantee mode they are forced into every simulation. Loss size scales to your starting capital by default so 3% means a 3% account hit per strategy."
                  />
                </div>
                <Input
                  id="worst-case-pct"
                  type="number"
                  min={0}
                  max={100}
                  value={worstCasePercentage}
                  disabled={isOptimizing || !worstCaseEnabled}
                  onChange={(e) => {
                    clearResults();
                    setWorstCasePercentage(Number(e.target.value));
                  }}
                />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor="worst-case-enabled">Worst-case enabled</Label>
                  <FieldExplainer
                    title="Worst-Case Scenario Testing"
                    contentWidth="w-96"
                    summary="Inject synthetic maximum-loss trades to stress-test your portfolio."
                    details="For each strategy, this creates trades that lose the full allocated margin (or largest historical loss when margin is missing). Enabled by default at 3% in pool mode so drawdown optimization accounts for tail-risk scenarios."
                  />
                </div>
                <Switch
                  id="worst-case-enabled"
                  checked={worstCaseEnabled}
                  disabled={isOptimizing}
                  onCheckedChange={(checked) => {
                    clearResults();
                    setWorstCaseEnabled(checked);
                  }}
                />
              </div>
              <div className="space-y-2 md:col-span-2 lg:col-span-3">
                <div className="flex items-center gap-2">
                  <Label className="text-sm font-medium">Worst-case mode</Label>
                  <FieldExplainer
                    title="Injection Modes"
                    details={
                      <div className="space-y-3">
                        <div>
                          <p className="text-xs font-medium text-foreground">
                            Add to pool:
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Max-loss trades are added to the pool and sampled
                            randomly. They may appear zero, one, or multiple
                            times per simulation.
                          </p>
                        </div>
                        <div>
                          <p className="text-xs font-medium text-foreground">
                            Force into every simulation:
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Each simulation must include the exact percentage of
                            max-loss trades, swapped in for baseline draws so
                            the horizon stays the same.
                          </p>
                        </div>
                      </div>
                    }
                  />
                </div>
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="worst-case-mode"
                      checked={worstCaseMode === "pool"}
                      disabled={isOptimizing || !worstCaseEnabled}
                      onChange={() => {
                        clearResults();
                        setWorstCaseMode("pool");
                      }}
                    />
                    Add to pool
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="worst-case-mode"
                      checked={worstCaseMode === "guarantee"}
                      disabled={isOptimizing || !worstCaseEnabled}
                      onChange={() => {
                        clearResults();
                        setWorstCaseMode("guarantee");
                      }}
                    />
                    Force into every simulation
                  </label>
                </div>
              </div>
              <div className="space-y-2 md:col-span-2">
                <div className="flex items-center gap-2">
                  <Label className="text-sm font-medium">Percentage based on</Label>
                  <FieldExplainer
                    title="Percentage Calculation Basis"
                    details={
                      <div className="space-y-3">
                        <div>
                          <p className="text-xs font-medium text-foreground">
                            Simulation length (recommended):
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Percentage is based on the simulation length. For
                            example, 3% of a 21-trade month adds about one
                            max-loss trade split across strategies.
                          </p>
                        </div>
                        <div>
                          <p className="text-xs font-medium text-foreground">
                            Historical data count:
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Percentage is based on each strategy&apos;s historical
                            trade count. Can inject more worst-case trades on
                            large datasets.
                          </p>
                        </div>
                      </div>
                    }
                  />
                </div>
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="worst-case-based-on"
                      checked={worstCaseBasedOn === "simulation"}
                      disabled={isOptimizing || !worstCaseEnabled}
                      onChange={() => {
                        clearResults();
                        setWorstCaseBasedOn("simulation");
                      }}
                    />
                    Simulation length
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="worst-case-based-on"
                      checked={worstCaseBasedOn === "historical"}
                      disabled={isOptimizing || !worstCaseEnabled}
                      onChange={() => {
                        clearResults();
                        setWorstCaseBasedOn("historical");
                      }}
                    />
                    Historical data count
                  </label>
                </div>
              </div>
              <div className="space-y-2 md:col-span-2">
                <div className="flex items-center gap-2">
                  <Label className="text-sm font-medium">Loss sizing</Label>
                  <FieldExplainer
                    title="How Max-Loss Size Is Calculated"
                    details={
                      <div className="space-y-3 text-xs text-muted-foreground leading-relaxed">
                        <p>
                          <span className="font-medium text-foreground">
                            Scale to account size (recommended):
                          </span>{" "}
                          Uses each strategy&apos;s worst observed loss as a
                          percentage of capital, then applies it to your current
                          starting capital.
                        </p>
                        <p>
                          <span className="font-medium text-foreground">
                            Use historical dollars:
                          </span>{" "}
                          Injects the raw worst-case dollar amount from the trade
                          log for exact historical blow-up replay.
                        </p>
                      </div>
                    }
                  />
                </div>
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="worst-case-sizing"
                      checked={worstCaseSizing === "relative"}
                      disabled={isOptimizing || !worstCaseEnabled}
                      onChange={() => {
                        clearResults();
                        setWorstCaseSizing("relative");
                      }}
                    />
                    Scale to account size
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="worst-case-sizing"
                      checked={worstCaseSizing === "absolute"}
                      disabled={isOptimizing || !worstCaseEnabled}
                      onChange={() => {
                        clearResults();
                        setWorstCaseSizing("absolute");
                      }}
                    />
                    Use historical dollars
                  </label>
                </div>
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor="fixed-seed">Fixed random seed</Label>
                  <FieldExplainer
                    title="Random Seed"
                    summary="Control whether simulations produce identical or varied results across runs."
                    details="Enable fixed seed for reproducible results — the same parameters always produce identical outputs. Essential for comparing baseline vs optimized weights fairly. Disable for varied random simulations each run."
                  />
                </div>
                <Switch
                  id="fixed-seed"
                  checked={useFixedSeed}
                  disabled={isOptimizing}
                  onCheckedChange={(checked) => {
                    clearResults();
                    setUseFixedSeed(checked);
                  }}
                />
              </div>
              {useFixedSeed ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="seed-value">Seed value</Label>
                    <FieldExplainer
                      title="Seed Value"
                      details="Any integer seed works. Change it to explore a different random draw while keeping runs reproducible for a given seed."
                    />
                  </div>
                  <Input
                    id="seed-value"
                    type="number"
                    value={seedValue}
                    disabled={isOptimizing}
                    onChange={(e) => {
                      clearResults();
                      setSeedValue(Number(e.target.value));
                    }}
                  />
                </div>
              ) : null}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={runOptimization}
          disabled={isOptimizing || !canRunOptimization}
          aria-busy={isOptimizing}
        >
          {isOptimizing ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" />
              Optimizing…
            </>
          ) : (
            <>
              <Play className="mr-2 size-4" />
              Run Optimization
            </>
          )}
        </Button>
        {isOptimizing ? (
          <Button variant="outline" onClick={cancelOptimization}>
            <Square className="mr-2 size-4" />
            Cancel
          </Button>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}
      </div>

      {isOptimizing ? (
        <Card className="border-dashed border-primary/40">
          <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
            <Loader2 className="size-8 animate-spin text-primary" />
            <div className="space-y-1">
              <p className="text-sm font-medium">
                Optimizing strategy weights…
              </p>
              <p className="text-xs text-muted-foreground">
                Running Monte Carlo on {optimizationStrategies.length} strategies
                ({filteredTrades.length} trades). Results will appear when
                finished — use Cancel to stop.
              </p>
            </div>
            {progress ? (
              <div className="grid w-full max-w-2xl gap-2 rounded-lg border bg-muted/30 p-4 text-left text-sm md:grid-cols-2 lg:grid-cols-4">
                <div>
                  <span className="text-muted-foreground">Phase: </span>
                  <span className="font-medium capitalize">{progress.phase}</span>
                </div>
                {progress.phase === "search" ? (
                  <>
                    <div>
                      <span className="text-muted-foreground">Pass: </span>
                      <span className="font-medium">
                        {progress.pass ?? 0}/{progress.maxPasses ?? maxPasses}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Strategy: </span>
                      <span className="font-medium">
                        {progress.strategyIndex ?? progress.tradeIndex ?? 0}/
                        {progress.strategyCount ??
                          progress.tradeCount ??
                          optimizationStrategies.length}
                      </span>
                    </div>
                  </>
                ) : null}
                <div>
                  <span className="text-muted-foreground">Best MDD: </span>
                  <span className="font-medium">
                    {Number.isFinite(progress.currentBestMdd)
                      ? formatPctDecimal(progress.currentBestMdd)
                      : "—"}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Starting baseline simulation…
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {isRevalidating ? (
        <Card className="border-dashed border-primary/40">
          <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="size-6 animate-spin text-primary" />
            <p className="text-sm font-medium">Re-validating custom weights…</p>
          </CardContent>
        </Card>
      ) : null}

      {optimizationResult && !isOptimizing ? (
        <DrawdownOptimizerResultsPanel
          baselineStats={optimizationResult.baselineStats}
          optimizedStats={optimizationResult.optimizedStats}
          improved={optimizationResult.improved}
          showCustomColumn={hasRevalidated}
          customStats={customStats}
        />
      ) : null}

      {optimizationResult && !isOptimizing ? (
      <Card>
        <CardHeader className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            Strategy Weights ({optimizationStrategies.length} strategies)
            <FieldExplainer
              title="Strategy Weights"
              summary="One contract multiplier per strategy, applied to all trades in that strategy."
              details="Edit weights manually after optimization, then Re-validate to populate the Custom results column. Weight 0 removes a strategy from Monte Carlo resampling. The Δ column shows change from the baseline multiplier of 1.0."
            />
          </CardTitle>
          {editedWeights ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={runRevalidate}
                disabled={
                  isOptimizing ||
                  isRevalidating ||
                  !weightValidation.valid ||
                  filteredTrades.length < 10
                }
              >
                {isRevalidating ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Re-validating…
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 size-4" />
                    Re-validate
                  </>
                )}
              </Button>
              <Button variant="outline" size="sm" onClick={exportWeightsCsv}>
                <Download className="mr-2 size-4" />
                Export CSV
              </Button>
              <Button variant="outline" size="sm" onClick={exportResultJson}>
                <Download className="mr-2 size-4" />
                Export JSON
              </Button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {optimizationStrategies.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No strategies match the current filter.
            </p>
          ) : editedWeights ? (
            <div className="space-y-3">
              {!weightValidation.valid ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {weightValidation.errors.map((message) => (
                    <p key={message}>{message}</p>
                  ))}
                </div>
              ) : null}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Strategy</TableHead>
                    <TableHead className="text-right">Trades</TableHead>
                    <TableHead className="text-right">Total P/L</TableHead>
                    <TableHead className="text-right">Worst Trade</TableHead>
                    <TableHead className="text-right">
                      <span className="inline-flex items-center justify-end gap-1">
                        Weight
                        <FieldExplainer
                          title="Strategy Weight"
                          details="Contract multiplier for every trade in this strategy. Scales P/L, commissions, margin, and max loss before Monte Carlo resampling."
                        />
                      </span>
                    </TableHead>
                    <TableHead className="text-right">
                      <span className="inline-flex items-center justify-end gap-1">
                        Δ vs 1.0
                        <FieldExplainer
                          title="Delta vs 1.0"
                          details="Difference from the baseline multiplier of 1.0 (equal sizing). +1 means double the default size; −1 with min 0 means the strategy is excluded."
                        />
                      </span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {strategySummaries.map((summary: StrategySummary) => {
                    const weight = editedWeights.get(summary.strategy) ?? 1;
                    const rowErrors = getRowWeightErrors(weight, weightConstraints);
                    const hasRowError = rowErrors.length > 0;
                    return (
                      <TableRow key={summary.strategy}>
                        <TableCell className="font-medium">
                          {summary.strategy}
                        </TableCell>
                        <TableCell className="text-right">
                          {summary.tradeCount}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(summary.totalPl)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(summary.worstTradePl)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-col items-end gap-1">
                            <Input
                              type="number"
                              min={weightMin}
                              max={weightMax}
                              step={effectiveWeightStep}
                              value={weight}
                              disabled={isOptimizing || isRevalidating}
                              className={cn(
                                "h-8 w-20 text-right",
                                hasRowError && "border-destructive"
                              )}
                              onChange={(e) =>
                                handleWeightChange(summary.strategy, e.target.value)
                              }
                            />
                            {rowErrors.map((message) => (
                              <span
                                key={message}
                                className="text-xs text-destructive"
                              >
                                {message}
                              </span>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          {formatWeightDelta(weight)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </CardContent>
      </Card>
      ) : null}
    </div>
  );
}
