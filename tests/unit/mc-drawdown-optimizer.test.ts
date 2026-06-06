/**
 * Unit tests for Monte Carlo Drawdown Optimizer weight scaling
 */

import {
  Trade,
  tradeFingerprint,
  applyTradeWeights,
  applyStrategyWeights,
  buildStrategySummaries,
  validateWeights,
  validateOptimizerInputs,
  optimizeTradeWeights,
  optimizeStrategyWeights,
  MIN_OPTIMIZER_TRADES,
  MIN_OPTIMIZER_STRATEGIES,
  revalidateCustomWeights,
  revalidateCustomStrategyWeights,
  buildDrawdownOptimizerWeightsCsv,
  buildDrawdownOptimizerStrategyWeightsCsv,
  serializeDrawdownOptimizerResult,
  OptimizationAbortedError,
  type WeightConstraints,
  type MonteCarloParams,
} from "@tradeblocks/lib";

function createMockTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    strategy: "Test Strategy",
    dateOpened: new Date("2024-01-01"),
    timeOpened: "09:30:00",
    dateClosed: new Date("2024-01-02"),
    timeClosed: "15:30:00",
    openingPrice: 100,
    closingPrice: 110,
    legs: "SPY 100C",
    premium: 500,
    pl: 1000,
    numContracts: 2,
    openingCommissionsFees: 5,
    closingCommissionsFees: 5,
    fundsAtClose: 101000,
    marginReq: 1000,
    maxLoss: -500,
    maxProfit: 800,
    openingShortLongRatio: 1.0,
    ...overrides,
  };
}

describe("mc-drawdown-optimizer", () => {
  describe("tradeFingerprint", () => {
    it("produces a stable composite key from trade identity fields", () => {
      const trade = createMockTrade();
      expect(tradeFingerprint(trade)).toBe(
        "2024-01-02|15:30:00|Test Strategy|SPY 100C|2|1000"
      );
    });
  });

  describe("applyTradeWeights", () => {
    it("scales pl, commissions, maxLoss, marginReq, and maxProfit by weight", () => {
      const trade = createMockTrade();
      const weights = new Map([[tradeFingerprint(trade), 2]]);

      const [scaled] = applyTradeWeights([trade], weights);

      expect(scaled.pl).toBe(2000);
      expect(scaled.openingCommissionsFees).toBe(10);
      expect(scaled.closingCommissionsFees).toBe(10);
      expect(scaled.maxLoss).toBe(-1000);
      expect(scaled.marginReq).toBe(2000);
      expect(scaled.maxProfit).toBe(1600);
      expect(scaled.numContracts).toBe(2);
    });

    it("recalculates fundsAtClose on running equity after scaling", () => {
      const trade1 = createMockTrade({
        dateClosed: new Date("2024-01-02"),
        timeClosed: "10:00:00",
        pl: 1000,
        fundsAtClose: 101000,
      });
      const trade2 = createMockTrade({
        dateClosed: new Date("2024-01-03"),
        timeClosed: "10:00:00",
        pl: -500,
        fundsAtClose: 100500,
      });
      const weights = new Map([
        [tradeFingerprint(trade1), 2],
        [tradeFingerprint(trade2), 1],
      ]);

      const scaled = applyTradeWeights([trade1, trade2], weights);

      expect(scaled).toHaveLength(2);
      expect(scaled[0].fundsAtClose).toBe(102000);
      expect(scaled[1].fundsAtClose).toBe(101500);
    });

    it("excludes weight-0 trades from the scaled output", () => {
      const kept = createMockTrade({ legs: "KEEP" });
      const dropped = createMockTrade({
        legs: "DROP",
        dateClosed: new Date("2024-01-05"),
        pl: -200,
      });
      const weights = new Map([
        [tradeFingerprint(kept), 1],
        [tradeFingerprint(dropped), 0],
      ]);

      const scaled = applyTradeWeights([kept, dropped], weights);

      expect(scaled).toHaveLength(1);
      expect(scaled[0].legs).toBe("KEEP");
    });
  });

  describe("applyStrategyWeights", () => {
    it("scales every trade in a strategy by the same multiplier", () => {
      const tradeA1 = createMockTrade({
        strategy: "Alpha",
        legs: "A1",
        pl: 1000,
      });
      const tradeA2 = createMockTrade({
        strategy: "Alpha",
        legs: "A2",
        pl: 500,
        dateClosed: new Date("2024-01-03"),
      });
      const tradeB = createMockTrade({
        strategy: "Beta",
        legs: "B1",
        pl: -200,
        dateClosed: new Date("2024-01-04"),
      });
      const weights = new Map([
        ["Alpha", 2],
        ["Beta", 1],
      ]);

      const scaled = applyStrategyWeights([tradeA1, tradeA2, tradeB], weights);

      expect(scaled.find((t) => t.legs === "A1")?.pl).toBe(2000);
      expect(scaled.find((t) => t.legs === "A2")?.pl).toBe(1000);
      expect(scaled.find((t) => t.legs === "B1")?.pl).toBe(-200);
    });

    it("excludes every trade in a zero-weight strategy", () => {
      const kept = createMockTrade({ strategy: "Keep", legs: "KEEP" });
      const dropped = createMockTrade({
        strategy: "Drop",
        legs: "DROP",
        dateClosed: new Date("2024-01-05"),
      });
      const weights = new Map([
        ["Keep", 1],
        ["Drop", 0],
      ]);

      const scaled = applyStrategyWeights([kept, dropped], weights);

      expect(scaled).toHaveLength(1);
      expect(scaled[0].strategy).toBe("Keep");
    });
  });

  describe("validateOptimizerInputs", () => {
    it("rejects fewer than the minimum trade count", () => {
      const result = validateOptimizerInputs(1, 2, {
        min: 0,
        max: 3,
        step: 1,
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain(String(MIN_OPTIMIZER_TRADES));
    });

    it("rejects fewer than the minimum strategy count", () => {
      const result = validateOptimizerInputs(12, 1, {
        min: 0,
        max: 3,
        step: 1,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes(String(MIN_OPTIMIZER_STRATEGIES)))).toBe(
        true
      );
    });

    it("rejects weight bounds that only allow a single weight", () => {
      const result = validateOptimizerInputs(12, 3, {
        min: 1,
        max: 1,
        step: 1,
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("at least 2 different weight values");
    });

    it("accepts valid trade count and weight range", () => {
      const result = validateOptimizerInputs(12, 3, {
        min: 0,
        max: 3,
        step: 1,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("validateWeights", () => {
    const defaultConstraints: WeightConstraints = {
      min: 0,
      max: 3,
      step: 1,
      maxZeroFraction: 0.1,
    };

    it("rejects when every trade has weight zero", () => {
      const trades = [createMockTrade(), createMockTrade({ legs: "B" })];
      const weights = new Map(
        trades.map((t) => [tradeFingerprint(t), 0] as const)
      );

      const result = validateWeights(trades, weights, defaultConstraints);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "At least one trade must have a non-zero weight"
      );
    });

    it("rejects when zero-weight trades exceed the cap", () => {
      const trades = Array.from({ length: 10 }, (_, i) =>
        createMockTrade({ legs: `T${i}`, pl: i })
      );
      const weights = new Map(
        trades.map((t, i) => [
          tradeFingerprint(t),
          i < 2 ? 1 : 0,
        ] as const)
      );

      const result = validateWeights(trades, weights, defaultConstraints);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("zero-weight"))).toBe(true);
    });

    it("rejects weights outside bounds or off-step", () => {
      const trade = createMockTrade();
      const weights = new Map([[tradeFingerprint(trade), 2.5]]);

      const result = validateWeights([trade], weights, defaultConstraints);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("accepts valid weights at the zero cap boundary", () => {
      const trades = Array.from({ length: 10 }, (_, i) =>
        createMockTrade({ legs: `T${i}`, pl: i })
      );
      const weights = new Map(
        trades.map((t, i) => [tradeFingerprint(t), i === 0 ? 0 : 1] as const)
      );

      const result = validateWeights(trades, weights, defaultConstraints);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("optimizeTradeWeights", () => {
    const weightConstraints: WeightConstraints = {
      min: 0,
      max: 3,
      step: 1,
      maxZeroFraction: 0.1,
    };

    function createSyntheticTrades(): Trade[] {
      const strategies = ["Strat-A", "Strat-B", "Strat-C"];
      const baseDate = new Date("2024-01-02");
      return Array.from({ length: 12 }, (_, i) =>
        createMockTrade({
          strategy: strategies[i % strategies.length],
          legs: `LEG-${i}`,
          dateClosed: new Date(baseDate.getTime() + i * 86_400_000),
          timeClosed: "10:00:00",
          pl: i === 0 ? -8000 : i === 1 ? -2000 : 200,
          fundsAtClose: 100_000 + i * 200,
          maxLoss: i <= 1 ? -8000 : -200,
        })
      );
    }

    function defaultMcParams(): MonteCarloParams {
      return {
        simulationLength: 21,
        resampleMethod: "trades",
        initialCapital: 100_000,
        tradesPerYear: 252,
        randomSeed: 42,
        normalizeTo1Lot: false,
        worstCaseEnabled: true,
        worstCasePercentage: 3,
        worstCaseMode: "pool",
        worstCaseBasedOn: "simulation",
        worstCaseSizing: "relative",
        numSimulations: 200,
      };
    }

    it("returns baseline and optimized results after baseline, search, and final validation", async () => {
      const trades = createSyntheticTrades();

      const result = await optimizeTradeWeights({
        trades,
        mcParams: defaultMcParams(),
        searchSimulations: 100,
        finalSimulations: 150,
        weightBounds: weightConstraints,
        maxPasses: 2,
        maxZeroFraction: 0.1,
        epsilon: 0.001,
      });

      expect(result.baselineWeights.size).toBe(trades.length);
      expect(result.optimizedWeights.size).toBe(trades.length);
      expect(result.baselineStats.parameters.numSimulations).toBe(150);
      expect(result.optimizedStats.parameters.numSimulations).toBe(150);
      expect(result.baselineStats.statistics.medianMaxDrawdown).toBeGreaterThan(
        0
      );
      expect(result.searchPhaseBaselineMdd).toBeGreaterThan(0);
      expect(result.searchPhaseOptimizedMdd).toBeGreaterThan(0);
      expect(typeof result.improved).toBe("boolean");
    });

    it("improves or matches baseline MDD on a synthetic fixture with dominant losers", async () => {
      const trades = createSyntheticTrades();

      const result = await optimizeTradeWeights({
        trades,
        mcParams: defaultMcParams(),
        searchSimulations: 150,
        finalSimulations: 200,
        weightBounds: weightConstraints,
        maxPasses: 3,
        maxZeroFraction: 0.1,
        epsilon: 0.001,
        randomSeed: 42,
      });

      expect(result.searchPhaseOptimizedMdd).toBeLessThanOrEqual(
        result.searchPhaseBaselineMdd + 0.001
      );
      expect(result.optimizedStats.statistics.medianMaxDrawdown).toBeLessThanOrEqual(
        result.baselineStats.statistics.medianMaxDrawdown + 0.001
      );
    });

    it("throws when trade count is below the optimizer minimum", async () => {
      const trades = [createMockTrade()];

      await expect(
        optimizeTradeWeights({
          trades,
          mcParams: defaultMcParams(),
          searchSimulations: 50,
          finalSimulations: 50,
          weightBounds: weightConstraints,
          maxPasses: 1,
          maxZeroFraction: 0.1,
          epsilon: 0.001,
        })
      ).rejects.toThrow(/At least 10 trades/i);
    });

    it("throws OptimizationAbortedError when the abort signal fires", async () => {
      const trades = createSyntheticTrades();
      const controller = new AbortController();
      controller.abort();

      await expect(
        optimizeTradeWeights({
          trades,
          mcParams: defaultMcParams(),
          searchSimulations: 50,
          finalSimulations: 50,
          weightBounds: weightConstraints,
          maxPasses: 1,
          maxZeroFraction: 0.1,
          epsilon: 0.001,
          signal: controller.signal,
        })
      ).rejects.toBeInstanceOf(OptimizationAbortedError);
    });

    it("emits progress events for baseline, search, and final phases", async () => {
      const trades = createSyntheticTrades();
      const events: Array<{ phase: string }> = [];

      await optimizeTradeWeights({
        trades,
        mcParams: defaultMcParams(),
        searchSimulations: 50,
        finalSimulations: 50,
        weightBounds: weightConstraints,
        maxPasses: 1,
        maxZeroFraction: 0.1,
        epsilon: 0.001,
        onProgress: (event) => events.push({ phase: event.phase }),
      });

      expect(events.some((e) => e.phase === "baseline")).toBe(true);
      expect(events.some((e) => e.phase === "search")).toBe(true);
      expect(events.some((e) => e.phase === "final")).toBe(true);
    });

    it("rejects invalid custom weights before running Monte Carlo", () => {
      const trades = [createMockTrade(), createMockTrade({ legs: "B" })];
      const weights = new Map(
        trades.map((t) => [tradeFingerprint(t), 0] as const)
      );

      expect(() =>
        revalidateCustomWeights({
          trades,
          weights,
          mcParams: defaultMcParams(),
          finalSimulations: 100,
          constraints: weightConstraints,
        })
      ).toThrow(/non-zero weight/i);
    });

    it("runs Monte Carlo at final simulation count for valid custom weights", () => {
      const trades = createSyntheticTrades();
      const weights = new Map(
        trades.map((t) => [tradeFingerprint(t), 1] as const)
      );

      const result = revalidateCustomWeights({
        trades,
        weights,
        mcParams: defaultMcParams(),
        finalSimulations: 175,
        constraints: weightConstraints,
        randomSeed: 42,
      });

      expect(result.parameters.numSimulations).toBe(175);
      expect(result.statistics.medianMaxDrawdown).toBeGreaterThan(0);
    });

    it("builds CSV rows with fingerprint, metadata, and weight columns", () => {
      const trade = createMockTrade();
      const weights = new Map([[tradeFingerprint(trade), 2]]);

      const lines = buildDrawdownOptimizerWeightsCsv([trade], weights);

      expect(lines[0]).toContain("fingerprint");
      expect(lines[0]).toContain("dateClosed");
      expect(lines[0]).toContain("weight");
      expect(lines[1]).toContain(tradeFingerprint(trade));
      expect(lines[1]).toContain("Test Strategy");
      expect(lines[1]).toContain("SPY 100C");
      expect(lines[1]).toContain("2");
    });

    it("serializes optimization result with weight maps as plain objects", async () => {
      const trades = createSyntheticTrades();
      const result = await optimizeStrategyWeights({
        trades,
        mcParams: defaultMcParams(),
        searchSimulations: 50,
        finalSimulations: 60,
        weightBounds: weightConstraints,
        maxPasses: 1,
        maxZeroFraction: 0.1,
        epsilon: 0.001,
        randomSeed: 42,
      });

      const serialized = serializeDrawdownOptimizerResult(result);

      expect(serialized.improved).toBe(result.improved);
      expect(serialized.baselineStrategyWeights).toEqual(
        Object.fromEntries(result.baselineStrategyWeights)
      );
      expect(serialized.optimizedStrategyWeights).toEqual(
        Object.fromEntries(result.optimizedStrategyWeights)
      );
      expect(serialized.baselineStats.statistics.medianMaxDrawdown).toBe(
        result.baselineStats.statistics.medianMaxDrawdown
      );
    });

    it("produces identical optimized weights for the same seed and inputs", async () => {
      const trades = createSyntheticTrades();
      const baseOptions = {
        trades,
        mcParams: defaultMcParams(),
        searchSimulations: 80,
        finalSimulations: 100,
        weightBounds: weightConstraints,
        maxPasses: 2,
        maxZeroFraction: 0.1,
        epsilon: 0.001,
        randomSeed: 42,
      };

      const first = await optimizeTradeWeights(baseOptions);
      const second = await optimizeTradeWeights(baseOptions);

      const firstWeights = [...first.optimizedWeights.entries()].sort();
      const secondWeights = [...second.optimizedWeights.entries()].sort();
      expect(secondWeights).toEqual(firstWeights);
    });
  });

  describe("optimizeStrategyWeights", () => {
    const weightConstraints: WeightConstraints = {
      min: 0,
      max: 3,
      step: 1,
      maxZeroFraction: 0.1,
    };

    function createSyntheticTrades(): Trade[] {
      const strategies = ["Strat-A", "Strat-B", "Strat-C", "Strat-D"];
      const baseDate = new Date("2024-01-02");
      return Array.from({ length: 16 }, (_, i) =>
        createMockTrade({
          strategy: strategies[i % strategies.length]!,
          legs: `LEG-${i}`,
          dateClosed: new Date(baseDate.getTime() + i * 86_400_000),
          timeClosed: "10:00:00",
          pl:
            strategies[i % strategies.length] === "Strat-A"
              ? -5000
              : strategies[i % strategies.length] === "Strat-B"
                ? -1000
                : 250,
          fundsAtClose: 100_000 + i * 200,
          maxLoss: -5000,
        })
      );
    }

    function defaultMcParams(): MonteCarloParams {
      return {
        simulationLength: 21,
        resampleMethod: "trades",
        initialCapital: 100_000,
        tradesPerYear: 252,
        randomSeed: 42,
        normalizeTo1Lot: false,
        worstCaseEnabled: true,
        worstCasePercentage: 3,
        worstCaseMode: "pool",
        worstCaseBasedOn: "simulation",
        worstCaseSizing: "relative",
        numSimulations: 200,
      };
    }

    it("returns one weight per strategy after optimization", async () => {
      const trades = createSyntheticTrades();

      const result = await optimizeStrategyWeights({
        trades,
        mcParams: defaultMcParams(),
        searchSimulations: 100,
        finalSimulations: 150,
        weightBounds: weightConstraints,
        maxPasses: 2,
        maxZeroFraction: 0.1,
        epsilon: 0.001,
      });

      expect(result.baselineStrategyWeights.size).toBe(4);
      expect(result.optimizedStrategyWeights.size).toBe(4);
      expect(result.baselineStats.parameters.numSimulations).toBe(150);
      expect(typeof result.improved).toBe("boolean");
    });

    it("rejects invalid custom strategy weights before running Monte Carlo", () => {
      const trades = createSyntheticTrades();
      const weights = new Map([
        ["Strat-A", 0],
        ["Strat-B", 0],
        ["Strat-C", 0],
        ["Strat-D", 0],
      ]);

      expect(() =>
        revalidateCustomStrategyWeights({
          trades,
          strategyWeights: weights,
          mcParams: defaultMcParams(),
          finalSimulations: 100,
          constraints: weightConstraints,
        })
      ).toThrow(/At least one strategy/i);
    });

    it("builds strategy CSV rows with metadata and weight columns", () => {
      const trades = createSyntheticTrades();
      const summaries = buildStrategySummaries(trades);
      const weights = new Map(summaries.map((s) => [s.strategy, 2] as const));

      const lines = buildDrawdownOptimizerStrategyWeightsCsv(summaries, weights);

      expect(lines[0]).toContain("strategy");
      expect(lines[0]).toContain("tradeCount");
      expect(lines[0]).toContain("weight");
      expect(lines.some((line) => line.includes("Strat-A"))).toBe(true);
      expect(lines.some((line) => line.endsWith(",2") || line.includes(",2,"))).toBe(
        true
      );
    });
  });
});
