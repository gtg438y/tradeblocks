import {
  DRAWDOWN_OPTIMIZER_DEFAULTS,
  getDrawdownComparisonDisplay,
} from "@tradeblocks/lib";

describe("drawdown-optimizer display", () => {
  describe("getDrawdownComparisonDisplay", () => {
    it("marks baseline as winner when optimization did not improve drawdown", () => {
      const display = getDrawdownComparisonDisplay(false);

      expect(display.baseline.isWinner).toBe(true);
      expect(display.baseline.badge).toBe("Winner");
      expect(display.optimized.isWinner).toBe(false);
      expect(display.optimized.badge).toBe("No improvement");
    });

    it("marks optimized as winner when drawdown improved", () => {
      const display = getDrawdownComparisonDisplay(true);

      expect(display.baseline.isWinner).toBe(false);
      expect(display.baseline.badge).toBeUndefined();
      expect(display.optimized.isWinner).toBe(true);
      expect(display.optimized.badge).toBe("Winner");
    });
  });

  describe("DRAWDOWN_OPTIMIZER_DEFAULTS", () => {
    it("matches the drawdown optimizer feature specification", () => {
      expect(DRAWDOWN_OPTIMIZER_DEFAULTS).toMatchObject({
        preloadInitialCapital: 35_000,
        simulationPeriodValue: 1,
        simulationPeriodUnit: "months",
        resamplePercentage: 100,
        searchSimulations: 2000,
        finalSimulations: 10_000,
        useFixedSeed: true,
        seedValue: 42,
        worstCaseEnabled: true,
        worstCasePercentage: 3,
        worstCaseMode: "pool",
        worstCaseBasedOn: "simulation",
        worstCaseSizing: "relative",
        weightMin: 0,
        weightMax: 3,
        weightStep: 1,
        useFractionalWeights: false,
        maxPasses: 5,
        maxZeroFraction: 0.1,
        resampleMethod: "trades",
        normalizeTo1Lot: false,
      });
    });
  });
});
