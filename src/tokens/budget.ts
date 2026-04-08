import type { Config } from "../config/config.js";
import { countTokens } from "./counter.js";

export interface BudgetResult {
  fits: boolean;
  totalTokens: number;
  remaining: number;
  suggestion: "load_full" | "load_section" | "needs_analysis";
}

export function canFit(
  systemPrompt: string,
  userMessage: string,
  fileContents: string[],
  config: Config
): BudgetResult {
  const usable =
    config.tokenLimit - config.reservedOutputTokens - config.systemPromptBudget;

  const fileTokens = fileContents.reduce(
    (sum, content) => sum + countTokens(content),
    0
  );
  const messageTokens = countTokens(userMessage);
  const totalTokens = fileTokens + messageTokens;
  const remaining = usable - totalTokens;

  let suggestion: BudgetResult["suggestion"];
  if (totalTokens <= usable) {
    suggestion = "load_full";
  } else if (totalTokens <= usable * 1.5) {
    suggestion = "load_section";
  } else {
    suggestion = "needs_analysis";
  }

  return {
    fits: totalTokens <= usable,
    totalTokens,
    remaining,
    suggestion,
  };
}