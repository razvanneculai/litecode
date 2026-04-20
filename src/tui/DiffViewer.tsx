import React, { useMemo } from "react";
import { Box, Text, useInput } from "ink";
import type { DiffState } from "./types.js";
import type { TuiStore } from "./store.js";

interface DiffViewerProps {
  diff: DiffState;
  store: TuiStore;
}

export function DiffViewer({ diff, store }: DiffViewerProps) {
  useInput((input) => {
    const key = input.toLowerCase();
    if (key === "y") store.resolveConfirm("yes");
    else if (key === "n") store.resolveConfirm("no");
    else if (key === "a") store.resolveConfirm("all");
    else if (key === "q") store.resolveConfirm("quit");
  });

  const lines = useMemo(
    () => diff.patch.split("\n").slice(2).filter(l => l.trim() || l.startsWith("+") || l.startsWith("-")),
    [diff.patch]
  );

  const labelColor = diff.label === "new file" ? "green" : diff.label === "deleted" ? "red" : "yellow";

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Diff header */}
      <Box>
        <Text bold>{diff.file}  </Text>
        <Text color={labelColor}>{diff.label}</Text>
      </Box>

      {/* Diff lines */}
      <Box flexDirection="column">
        {lines.map((line, i) => {
          if (line.startsWith("@@")) return <Text key={i} color="cyan">{line}</Text>;
          if (line.startsWith("+")) return <Text key={i} color="green">{line}</Text>;
          if (line.startsWith("-")) return <Text key={i} color="red">{line}</Text>;
          return <Text key={i} dimColor>{line}</Text>;
        })}
      </Box>

      {/* Confirm prompt */}
      <Box marginTop={1}>
        <Text bold>Apply? </Text>
        <Text color="green">[y]es </Text>
        <Text color="red">[n]o </Text>
        <Text color="cyan">[a]ll </Text>
        <Text color="yellow">[q]uit</Text>
      </Box>
    </Box>
  );
}
