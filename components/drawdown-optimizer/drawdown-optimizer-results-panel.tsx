"use client";

import { FieldExplainer } from "@/components/drawdown-optimizer/field-explainer";
import { StatisticsCards } from "@/components/risk-simulator/statistics-cards";
import {
  DrawdownDistributionChart,
  ReturnDistributionChart,
} from "@/components/risk-simulator/distribution-charts";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn, getDrawdownComparisonDisplay } from "@tradeblocks/lib";
import type { MonteCarloResult } from "@tradeblocks/lib";

interface DrawdownOptimizerResultsPanelProps {
  baselineStats: MonteCarloResult;
  optimizedStats: MonteCarloResult;
  improved: boolean;
  showCustomColumn?: boolean;
  customStats?: MonteCarloResult | null;
}

interface ResultColumnProps {
  title: string;
  explainerTitle: string;
  explainerSummary: string;
  explainerDetails: string;
  result: MonteCarloResult;
  isWinner: boolean;
  badge?: string;
}

function ResultColumn({
  title,
  explainerTitle,
  explainerSummary,
  explainerDetails,
  result,
  isWinner,
  badge,
}: ResultColumnProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          <FieldExplainer
            iconSize="md"
            title={explainerTitle}
            summary={explainerSummary}
            details={explainerDetails}
          />
        </div>
        {badge ? <Badge variant="secondary">{badge}</Badge> : null}
      </div>
      <Card className={cn("p-4", isWinner && "border-emerald-500/50")}>
        <StatisticsCards result={result} />
      </Card>
      <div className="grid grid-cols-1 gap-6">
        <ReturnDistributionChart result={result} />
        <DrawdownDistributionChart result={result} />
      </div>
    </div>
  );
}

export function DrawdownOptimizerResultsPanel({
  baselineStats,
  optimizedStats,
  improved,
  showCustomColumn = false,
  customStats,
}: DrawdownOptimizerResultsPanelProps) {
  const display = getDrawdownComparisonDisplay(improved);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">Monte Carlo Comparison</h2>
        <FieldExplainer
          iconSize="md"
          title="Monte Carlo Comparison"
          summary="Side-by-side projections for baseline, optimized, and optional custom weights."
          details="The optimizer minimizes median max drawdown (P50). The winner badge marks the lower median MDD column; when there is no meaningful improvement, baseline wins. Statistics cards and distribution charts reuse the Risk Simulator explainers."
        />
      </div>
      <div
        className={cn(
          "grid gap-8",
          showCustomColumn ? "lg:grid-cols-3" : "lg:grid-cols-2"
        )}
      >
      <ResultColumn
        title="Baseline"
        explainerTitle="Baseline"
        explainerSummary="Equal weight 1.0 on every strategy in the optimization universe."
        explainerDetails="Monte Carlo run at the final simulation count before any sizing changes. This is the reference portfolio for drawdown comparison."
        result={baselineStats}
        isWinner={display.baseline.isWinner}
        badge={display.baseline.badge}
      />
      <ResultColumn
        title="Optimized"
        explainerTitle="Optimized"
        explainerSummary="Per-strategy weights found by coordinate descent to lower median max drawdown."
        explainerDetails="Shown even when the optimizer finds no improvement over baseline — compare distributions to see whether alternate sizing helped tail risk or returns."
        result={optimizedStats}
        isWinner={display.optimized.isWinner}
        badge={display.optimized.badge}
      />
      {showCustomColumn ? (
        customStats ? (
          <ResultColumn
            title="Custom"
            explainerTitle="Custom"
            explainerSummary="Your manually edited strategy weights after Re-validate."
            explainerDetails="Uses the final simulation count from Advanced settings. Appears only after a successful Re-validate run with valid weights."
            result={customStats}
            isWinner={false}
          />
        ) : (
          <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Re-validate to update custom results
          </div>
        )
      ) : null}
      </div>
    </div>
  );
}
