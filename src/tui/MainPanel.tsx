import React, { useState, useEffect, useMemo, memo } from "react";
import { Box, Text, useInput, useStdout, useStdin } from "ink";
import type { ChatLine, TaskState, DiffState } from "./types.js";
import { DiffViewer } from "./DiffViewer.js";
import type { TuiStore } from "./store.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SIDEBAR_RESERVED = 30; // sidebar 28 + divider 1 + paddingRight 1

interface MainPanelProps {
  messages: ChatLine[];
  activeTasks: Map<string, TaskState>;
  spinner: string | null;
  pendingDiff: DiffState | null;
  store: TuiStore;
  termHeight: number;
}

function lineColor(kind: ChatLine["kind"]): string | undefined {
  switch (kind) {
    case "success": return "green";
    case "error": return "red";
    case "warn": return "yellow";
    case "thinking": return "cyan";
    case "section": return "white";
    case "task_done": return "green";
    case "task_failed": return "red";
    case "wave": return "gray";
    case "file_write": return "green";
    case "file_fail": return "red";
    case "user": return "cyan";
    default: return undefined;
  }
}

function linePrefix(kind: ChatLine["kind"]): string {
  switch (kind) {
    case "user": return "› ";
    case "success": return "  ✓ ";
    case "error": return "  ✗ ";
    case "warn": return "  – ";
    case "thinking": return "  · ";
    case "section": return "  ";
    case "task_done": return "  ✓ ";
    case "task_failed": return "  ✗ ";
    case "wave": return "  ";
    case "file_write": return "  ✓ Write ";
    case "file_fail": return "  ✗ Fail  ";
    case "answer": return "  ";
    default: return "  · ";
  }
}

// Block-level spacing: answers and user prompts get a blank line before for readability.
function hasBlockSpacing(kind: ChatLine["kind"]): boolean {
  return kind === "user" || kind === "answer" || kind === "section";
}

// Approximate rendered-row count: sum across explicit newlines of ceil(len/width).
function countRows(text: string, prefix: string, width: number): number {
  if (width <= 0) return 1;
  const full = prefix + text;
  const parts = full.split("\n");
  let rows = 0;
  for (const p of parts) {
    rows += Math.max(1, Math.ceil(p.length / width));
  }
  return rows;
}

function SpinnerFrame() {
  const [f, setF] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setF(x => x + 1), 150);
    return () => clearInterval(t);
  }, []);
  return <Text color="cyan">{SPINNER_FRAMES[f % SPINNER_FRAMES.length]}</Text>;
}

// Enable xterm SGR mouse wheel events. Most modern terminals (Windows Terminal,
// iTerm2, VS Code, gnome-terminal) support this. Tradeoff: native click-drag
// text selection is suppressed while enabled — users hold Shift to select.
function useMouseWheel(onWheel: (direction: "up" | "down") => void, enabled: boolean) {
  const { stdin, setRawMode, isRawModeSupported } = useStdin();

  useEffect(() => {
    if (!enabled || !isRawModeSupported) return;
    setRawMode(true);
    const out = process.stdout;
    // Enable button reporting + SGR extended mode
    out.write("\x1b[?1000h\x1b[?1006h");

    const onData = (data: Buffer) => {
      const s = data.toString("utf8");
      // SGR format: ESC [ < btn ; x ; y M/m
      const re = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) !== null) {
        const btn = parseInt(m[1], 10);
        if (btn === 64) onWheel("up");
        else if (btn === 65) onWheel("down");
      }
    };
    stdin.on("data", onData);

    return () => {
      out.write("\x1b[?1000l\x1b[?1006l");
      stdin.off("data", onData);
    };
  }, [stdin, setRawMode, isRawModeSupported, onWheel, enabled]);
}

function MainPanelImpl({ messages, activeTasks, spinner, pendingDiff, store, termHeight }: MainPanelProps) {
  const { stdout } = useStdout();
  const termWidth = stdout.columns ?? 100;
  const width = Math.max(20, termWidth - SIDEBAR_RESERVED);

  const [scrollOffset, setScrollOffset] = useState(0); // rows from bottom

  const diffLines = pendingDiff ? Math.min(pendingDiff.patch.split("\n").length + 3, 20) : 0;
  const liveLines = (activeTasks.size > 0 ? activeTasks.size : (spinner ? 1 : 0)) + diffLines;
  const maxRows = Math.max(4, termHeight - 8 - liveLines);

  // Row heights per message (memoized — recompute only when messages or width change)
  const rowHeights = useMemo(
    () => messages.map(m => {
      const base = countRows(m.text, linePrefix(m.kind), width);
      return hasBlockSpacing(m.kind) ? base + 1 : base;
    }),
    [messages, width]
  );

  const totalRows = useMemo(() => rowHeights.reduce((a, b) => a + b, 0), [rowHeights]);
  const maxOffset = Math.max(0, totalRows - maxRows);

  useInput((_input, key) => {
    if (pendingDiff) return;
    if (key.upArrow)        setScrollOffset(o => Math.min(maxOffset, o + 1));
    else if (key.downArrow) setScrollOffset(o => Math.max(0, o - 1));
    else if (key.pageUp)    setScrollOffset(o => Math.min(maxOffset, o + Math.floor(maxRows / 2)));
    else if (key.pageDown)  setScrollOffset(o => Math.max(0, o - Math.floor(maxRows / 2)));
    else if (_input === "g")  setScrollOffset(maxOffset); // jump to top
    else if (_input === "G")  setScrollOffset(0);          // jump to bottom
  });

  const onWheel = React.useCallback((dir: "up" | "down") => {
    if (dir === "up")   setScrollOffset(o => Math.min(maxOffset, o + 3));
    else                setScrollOffset(o => Math.max(0, o - 3));
  }, [maxOffset]);
  useMouseWheel(onWheel, !pendingDiff);

  // Clamp offset when content shrinks below current scroll position.
  useEffect(() => {
    if (scrollOffset > maxOffset) setScrollOffset(maxOffset);
  }, [maxOffset, scrollOffset]);

  // Walk messages from the end to build a window of exactly maxRows, honoring scrollOffset.
  // We want: bottom of window = totalRows - scrollOffset.
  const bottomRow = totalRows - scrollOffset;
  const topRow = Math.max(0, bottomRow - maxRows);

  // Find first visible message and its internal row trim
  let cursor = 0;
  let startIdx = 0;
  let rowsSkipped = 0;
  for (let i = 0; i < messages.length; i++) {
    const h = rowHeights[i];
    if (cursor + h > topRow) {
      startIdx = i;
      rowsSkipped = topRow - cursor; // rows to skip within this message (visually we just hide it)
      break;
    }
    cursor += h;
  }

  // Find last visible message
  let endIdx = messages.length;
  let cursor2 = 0;
  for (let i = 0; i < messages.length; i++) {
    cursor2 += rowHeights[i];
    if (cursor2 >= bottomRow) { endIdx = i + 1; break; }
  }

  const visibleMessages = messages.slice(startIdx, endIdx);
  const hiddenAbove = startIdx + (rowsSkipped > 0 ? 0 : 0); // count-of-messages indicator
  const hiddenBelow = scrollOffset;

  return (
    <Box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1} overflow="hidden">
      {hiddenAbove > 0 && (
        <Box>
          <Text dimColor>  ↑ {hiddenAbove} earlier message{hiddenAbove === 1 ? "" : "s"}</Text>
        </Box>
      )}

      <Box flexDirection="column" flexGrow={1}>
        {visibleMessages.map(line => (
          <Box key={line.id} flexDirection="column" marginTop={hasBlockSpacing(line.kind) ? 1 : 0}>
            <Text
              bold={line.kind === "section" || line.kind === "user"}
              color={lineColor(line.kind)}
              dimColor={line.kind === "thinking" || line.kind === "wave"}
              wrap="wrap"
            >
              {linePrefix(line.kind)}{line.text}
            </Text>
          </Box>
        ))}
      </Box>

      {hiddenBelow > 0 && (
        <Box>
          <Text dimColor>  ↓ {hiddenBelow} row{hiddenBelow === 1 ? "" : "s"} below  (press G or End to jump)</Text>
        </Box>
      )}

      {activeTasks.size > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {Array.from(activeTasks.values()).map(t => (
            <Box key={t.id}>
              <Text color="cyan">  </Text>
              <SpinnerFrame />
              <Text color="cyan"> {t.id}  </Text>
              <Text>{t.file}</Text>
              {t.tokens != null ? <Text dimColor>  {t.tokens} tok</Text> : null}
            </Box>
          ))}
        </Box>
      )}

      {spinner && activeTasks.size === 0 && (
        <Box marginTop={1}>
          <Text color="cyan">  </Text>
          <SpinnerFrame />
          <Text dimColor> {spinner}</Text>
        </Box>
      )}

      {pendingDiff && <DiffViewer diff={pendingDiff} store={store} />}
    </Box>
  );
}

export const MainPanel = memo(MainPanelImpl, (prev, next) =>
  prev.messages === next.messages &&
  prev.activeTasks === next.activeTasks &&
  prev.spinner === next.spinner &&
  prev.pendingDiff === next.pendingDiff &&
  prev.termHeight === next.termHeight &&
  prev.store === next.store
);
