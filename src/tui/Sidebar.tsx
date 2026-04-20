import React, { memo } from "react";
import { Box, Text } from "ink";
import type { TokenState } from "./types.js";

const BAR_WIDTH = 18;

function buildBar(pct: number): string {
  const filled = Math.min(BAR_WIDTH, Math.round((pct / 100) * BAR_WIDTH));
  const empty = BAR_WIDTH - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function barColor(pct: number): string {
  if (pct > 85) return "red";
  if (pct > 60) return "yellow";
  return "green";
}

interface SidebarProps {
  tokens: TokenState;
  model: string;
  baseURL: string;
  tokenLimit: number;
}

function SidebarImpl({ tokens, model, baseURL, tokenLimit }: SidebarProps) {
  const host = baseURL.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const lastTotal = tokens.lastUsage?.totalTokens ?? 0;
  const budgetPct = tokenLimit > 0 ? Math.round((lastTotal / tokenLimit) * 100) : 0;
  const bar = buildBar(budgetPct);
  const color = barColor(budgetPct);

  return (
    <Box flexDirection="column" width={28} paddingLeft={1} paddingRight={1}>
      {/* Model */}
      <Box marginBottom={1}>
        <Text bold color="cyan">◆ </Text>
        <Box flexDirection="column">
          <Text color="cyan">{model || "no model"}</Text>
          {host ? <Text dimColor>{host}</Text> : null}
        </Box>
      </Box>

      {/* Divider */}
      <Text dimColor>{"─".repeat(25)}</Text>

      {/* Last call */}
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Text bold>Last call</Text>
        {tokens.lastUsage ? (
          <>
            <Box>
              <Text dimColor>  in   </Text>
              <Text color="cyan">{tokens.lastUsage.promptTokens.toLocaleString()}</Text>
            </Box>
            <Box>
              <Text dimColor>  out  </Text>
              <Text color="green">{tokens.lastUsage.completionTokens.toLocaleString()}</Text>
            </Box>
            <Box>
              <Text dimColor>  tot  </Text>
              <Text>{tokens.lastUsage.totalTokens.toLocaleString()}</Text>
            </Box>
          </>
        ) : (
          <Text dimColor>  —</Text>
        )}
      </Box>

      {/* Budget bar */}
      {tokens.lastUsage && tokenLimit > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Budget</Text>
          <Box>
            <Text dimColor>  [</Text>
            <Text color={color}>{bar}</Text>
            <Text dimColor>]</Text>
          </Box>
          <Text dimColor>  {lastTotal}/{tokenLimit} ({budgetPct}%)</Text>
        </Box>
      ) : null}

      {/* Divider */}
      <Text dimColor>{"─".repeat(25)}</Text>

      {/* Session totals */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Session</Text>
        <Box>
          <Text dimColor>  in   </Text>
          <Text color="cyan">{tokens.sessionPrompt.toLocaleString()}</Text>
        </Box>
        <Box>
          <Text dimColor>  out  </Text>
          <Text color="green">{tokens.sessionCompletion.toLocaleString()}</Text>
        </Box>
        <Box>
          <Text dimColor>  tot  </Text>
          <Text>{tokens.sessionTotal.toLocaleString()}</Text>
        </Box>
        <Box>
          <Text dimColor>  req  </Text>
          <Text>{tokens.requestCount}</Text>
        </Box>
      </Box>

      {/* Rate limit */}
      {tokens.lastUsage?.rateLimitRemaining != null ? (
        <Box marginTop={1}>
          <Text dimColor>  rl   </Text>
          <Text color={tokens.lastUsage.rateLimitRemaining <= 2 ? "red" : "gray"}>
            {tokens.lastUsage.rateLimitRemaining} left
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export const Sidebar = memo(SidebarImpl, (prev, next) =>
  prev.tokenLimit === next.tokenLimit &&
  prev.model === next.model &&
  prev.baseURL === next.baseURL &&
  prev.tokens.sessionTotal === next.tokens.sessionTotal &&
  prev.tokens.requestCount === next.tokens.requestCount &&
  prev.tokens.lastUsage === next.tokens.lastUsage
);
