import { render, screen } from "@testing-library/react";
import { DrawdownOptimizerResultsPanel } from "@/components/drawdown-optimizer/drawdown-optimizer-results-panel";
import type { MonteCarloResult } from "@tradeblocks/lib";

jest.mock("@/components/risk-simulator/distribution-charts", () => ({
  ReturnDistributionChart: () => (
    <div data-testid="return-distribution-chart">Return Distribution</div>
  ),
  DrawdownDistributionChart: () => (
    <div data-testid="drawdown-distribution-chart">Drawdown Analysis</div>
  ),
}));

function createMockMonteCarloResult(
  overrides: Partial<MonteCarloResult["statistics"]> = {}
): MonteCarloResult {
  const statistics = {
    meanFinalValue: 110_000,
    medianFinalValue: 108_000,
    stdFinalValue: 5000,
    meanTotalReturn: 0.1,
    medianTotalReturn: 0.08,
    meanAnnualizedReturn: 0.12,
    medianAnnualizedReturn: 0.1,
    meanMaxDrawdown: 0.15,
    medianMaxDrawdown: 0.12,
    meanSharpeRatio: 1.2,
    probabilityOfProfit: 0.65,
    valueAtRisk: { p5: -0.05, p10: -0.03, p25: -0.01 },
    ...overrides,
  };

  return {
    simulations: [
      {
        totalReturn: 0.08,
        maxDrawdown: 0.12,
        equityCurve: [100_000, 108_000],
        finalValue: 108_000,
        annualizedReturn: 0.1,
      },
      {
        totalReturn: 0.1,
        maxDrawdown: 0.1,
        equityCurve: [100_000, 110_000],
        finalValue: 110_000,
        annualizedReturn: 0.12,
      },
      {
        totalReturn: 0.06,
        maxDrawdown: 0.14,
        equityCurve: [100_000, 106_000],
        finalValue: 106_000,
        annualizedReturn: 0.08,
      },
    ],
    percentiles: {
      steps: [0, 1],
      p5: [100_000, 102_000],
      p25: [100_000, 105_000],
      p50: [100_000, 108_000],
      p75: [100_000, 112_000],
      p95: [100_000, 115_000],
    },
    statistics,
    parameters: {
      numSimulations: 10_000,
      simulationLength: 21,
      tradesPerYear: 252,
      resampleMethod: "trades",
      initialCapital: 100_000,
      normalizeTo1Lot: false,
      worstCaseEnabled: true,
      worstCasePercentage: 3,
      worstCaseMode: "pool",
      worstCaseBasedOn: "simulation",
      worstCaseSizing: "relative",
      randomSeed: 42,
    },
    timestamp: new Date("2024-06-01"),
    actualResamplePoolSize: 120,
  };
}

describe("DrawdownOptimizerResultsPanel", () => {
  it("renders baseline and optimized statistics with distribution charts", () => {
    render(
      <DrawdownOptimizerResultsPanel
        baselineStats={createMockMonteCarloResult({ medianMaxDrawdown: 0.14 })}
        optimizedStats={createMockMonteCarloResult({ medianMaxDrawdown: 0.1 })}
        improved
      />
    );

    expect(screen.getByRole("heading", { name: "Baseline" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Optimized" })).toBeInTheDocument();
    expect(screen.getAllByText("Expected Return")).toHaveLength(2);
    expect(screen.getAllByTestId("return-distribution-chart")).toHaveLength(2);
    expect(screen.getAllByTestId("drawdown-distribution-chart")).toHaveLength(2);
  });

  it("shows no-improvement badge on optimized and winner on baseline when not improved", () => {
    render(
      <DrawdownOptimizerResultsPanel
        baselineStats={createMockMonteCarloResult({ medianMaxDrawdown: 0.1 })}
        optimizedStats={createMockMonteCarloResult({ medianMaxDrawdown: 0.12 })}
        improved={false}
      />
    );

    expect(screen.getAllByText("Winner")).toHaveLength(1);
    expect(screen.getByText("No improvement")).toBeInTheDocument();
  });
});
