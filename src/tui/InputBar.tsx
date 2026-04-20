import React, { useState, memo } from "react";
import { Box, Text, useInput } from "ink";

interface InputBarProps {
  onSubmit: (text: string) => void;
  disabled: boolean;
}

function InputBarImpl({ onSubmit, disabled }: InputBarProps) {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (disabled) return;
    if (key.return) {
      const trimmed = value.trim();
      if (trimmed) {
        setValue("");
        onSubmit(trimmed);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue(v => v.slice(0, -1));
      return;
    }
    if (key.ctrl && input === "c") {
      process.exit(0);
    }
    if (!key.ctrl && !key.meta && input) {
      setValue(v => v + input);
    }
  });

  return (
    <Box borderStyle="single" borderColor={disabled ? "gray" : "cyan"} paddingLeft={1} paddingRight={1}>
      <Text color="cyan">{"> "}</Text>
      <Text>{value}</Text>
      {!disabled && <Text color="cyan">{"▋"}</Text>}
    </Box>
  );
}

// Memoize on `disabled` + stable `onSubmit` so unrelated store updates (messages,
// tokens, tasks) don't re-render the input bar — which would force a full-tree
// repaint every time the pipeline emits an event.
export const InputBar = memo(InputBarImpl, (prev, next) =>
  prev.disabled === next.disabled && prev.onSubmit === next.onSubmit
);
