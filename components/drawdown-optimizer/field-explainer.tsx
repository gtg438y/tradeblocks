"use client";

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { HelpCircle } from "lucide-react";
import type { ReactNode } from "react";

interface FieldExplainerProps {
  title: string;
  summary?: string;
  details: ReactNode;
  iconSize?: "sm" | "md";
  contentWidth?: "w-72" | "w-80" | "w-96";
}

export function FieldExplainer({
  title,
  summary,
  details,
  iconSize = "sm",
  contentWidth = "w-80",
}: FieldExplainerProps) {
  const iconClass =
    iconSize === "md"
      ? "h-4 w-4 text-muted-foreground/60 cursor-help"
      : "h-3.5 w-3.5 text-muted-foreground/60 cursor-help";

  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <HelpCircle className={iconClass} />
      </HoverCardTrigger>
      <HoverCardContent className={`${contentWidth} p-0 overflow-hidden`}>
        <div className="space-y-3">
          <div className="bg-primary/5 border-b px-4 py-3">
            <h4 className="text-sm font-semibold text-primary">{title}</h4>
          </div>
          <div className="px-4 pb-4 space-y-3">
            {summary ? (
              <p className="text-sm font-medium text-foreground leading-relaxed">
                {summary}
              </p>
            ) : null}
            {typeof details === "string" ? (
              <p className="text-xs text-muted-foreground leading-relaxed">
                {details}
              </p>
            ) : (
              details
            )}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
