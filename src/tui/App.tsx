import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Box, Text, useStdout } from "ink";
import type { TuiStore } from "./store.js";
import type { TuiState } from "./types.js";
import { Sidebar } from "./Sidebar.js";
import { MainPanel } from "./MainPanel.js";
import { InputBar } from "./InputBar.js";
import type { Config } from "../config/config.js";

interface AppProps {
  store: TuiStore;
  config: Config;
  onSubmit: (text: string) => Promise<void>;
}

export default function App({ store, config, onSubmit }: AppProps) {
  const [state, setState] = useState<TuiState>(store.state);
  const { stdout } = useStdout();

  useEffect(() => {
    const onUpdate = () => setState({ ...store.state });
    store.on("update", onUpdate);
    return () => { store.off("update", onUpdate); };
  }, [store]);

  const handleSubmit = useCallback(async (text: string) => {
    store.state = { ...store.state, busy: true };
    store.dispatch({ type: "message", kind: "user", text });
    try {
      await onSubmit(text);
    } finally {
      store.dispatch({ type: "pipeline_done" });
    }
  }, [store, onSubmit]);

  const termHeight = stdout.rows ?? 40;
  const model = config.provider?.model ?? "";
  const baseURL = config.provider?.baseURL ?? "";
  const divider = useMemo(() => "│".repeat(Math.max(0, termHeight - 4)), [termHeight]);

  return (
    <Box flexDirection="column" height={termHeight - 1}>
      {/* Banner line */}
      <Box borderStyle="single" borderColor="cyan" paddingLeft={1} paddingRight={1}>
        <Text bold color="cyan">litecode</Text>
        <Text dimColor>  AI Coding Agent · Small Context LLMs</Text>
        <Text dimColor>  {state.busy ? "●" : "○"}</Text>
      </Box>

      {/* Main area */}
      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {/* Left: chat + diffs */}
        <MainPanel
          messages={state.messages}
          activeTasks={state.activeTasks}
          spinner={state.spinner}
          pendingDiff={state.pendingDiff}
          store={store}
          termHeight={termHeight}
        />

        {/* Divider */}
        <Box flexDirection="column" width={1}>
          <Text dimColor>{divider}</Text>
        </Box>

        {/* Right: token sidebar */}
        <Sidebar
          tokens={state.tokens}
          model={model}
          baseURL={baseURL}
          tokenLimit={config.tokenLimit ?? 8192}
        />
      </Box>

      {/* Input */}
      <InputBar onSubmit={handleSubmit} disabled={state.busy || state.pendingDiff !== null} />
    </Box>
  );
}
