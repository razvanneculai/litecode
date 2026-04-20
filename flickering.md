# TUI Flickering Analysis

## Overview
The TUI (Terminal User Interface) built with Ink experiences noticeable flickering during two primary scenarios:
1. **While typing** - Every keystroke causes visual flicker
2. **While the agent is "thinking"/working** - Continuous flickering during LLM operations

## Root Causes

### 1. Aggressive Spinner Animation
**Location:** `src/tui/MainPanel.tsx` (line 57)

```typescript
const timer = setInterval(() => setSpinnerFrame(f => f + 1), 80);
```

The spinner updates every **80 milliseconds** while the agent is working. This triggers a full re-render of the MainPanel component 12.5 times per second.

**Impact:** High - Causes continuous visual churn even when no actual content changes.

---

### 2. Every Keystroke Triggers Re-render
**Location:** `src/tui/InputBar.tsx` (lines 12-31)

```typescript
useInput((input, key) => {
  // ...
  if (!key.ctrl && !key.meta && input) {
    setValue(v => v + input);  // React state update on EVERY character
  }
});
```

The input uses React controlled state, causing the entire Ink tree to re-render on every single keystroke.

**Impact:** Medium - Fast typists see flicker with each character.

---

### 3. Store Emits "update" on Every Dispatch
**Location:** `src/tui/store.ts` (line 106)

```typescript
dispatch(event: TuiEvent): void {
  switch (event.type) {
    // ... handle event
  }
  this.emit("update");  // <-- Always emits, even for batchable events
}
```

Every single event dispatched (spinner updates, thinking messages, task progress) immediately triggers an App re-render.

**Impact:** High - Multiple events can fire in rapid succession during execution.

---

### 4. Accumulating "Thinking" Messages
**Location:** `src/orchestrator/executor.ts` (lines 52-63)

```typescript
if (!budget.fits && !task.load_sections) {
  display?.thinking(`${task.file}: still over budget...`);
  // ...
  if (!budget.fits) {
    display?.warn(`${task.file}: still over budget...`);
  }
}
```

Budget-related messages are added as new chat lines, triggering history re-renders.

**Location:** `src/orchestrator/scheduler.ts` (lines 95-104)

```typescript
display?.startSpinner("Executing tasks…");
// ... wave processing ...
display?.stopSpinner("Execution complete");
```

---

### 5. Spinner Update Messages
**Location:** `src/ui/display.ts` (line 195)

The plain CLI display updates spinner text frequently:

```typescript
this.updateSpinner(`${c.cyan(taskId)} ${file}${tokenStr}`);
```

In the TUI, `updateSpinner` dispatches to the store, causing re-renders.

---

## Event Flow (What Causes Re-renders)

```
User types 'h' → InputBar.setValue() → App re-renders
                                    ↓
Orchestrator calls → display.thinking() → store.dispatch()
                                         ↓
                                    store.emit("update")
                                         ↓
                                    App.tsx useEffect listener
                                         ↓
                                    setState({ ...store.state })
                                         ↓
                                    Full Ink re-render
```

## Potential Solutions

### Option 1: Reduce Spinner Frequency (Quick Fix)
**File:** `src/tui/MainPanel.tsx`

Change the interval from 80ms to 200ms:

```typescript
const timer = setInterval(() => setSpinnerFrame(f => f + 1), 200);
```

**Pros:** Simple, reduces re-render rate by 60%  
**Cons:** Doesn't address root cause (still re-renders unnecessarily)

---

### Option 2: Batch Store Emissions (Recommended)
**File:** `src/tui/store.ts`

Batch multiple dispatches into a single update:

```typescript
private pendingUpdate = false;

dispatch(event: TuiEvent): void {
  // ... process event ...
  
  if (!this.pendingUpdate) {
    this.pendingUpdate = true;
    process.nextTick(() => {
      this.pendingUpdate = false;
      this.emit("update");
    });
  }
}
```

**Pros:** Batches rapid-fire events into single re-render  
**Cons:** Slight delay (one tick) for updates

---

### Option 3: Throttle Input Updates
**File:** `src/tui/InputBar.tsx`

Use uncontrolled input or debounce:

```typescript
// Uncontrolled approach - let Ink handle terminal directly
import { useStdin } from 'ink';

export function InputBar({ onSubmit, disabled }: InputBarProps) {
  const [displayValue, setDisplayValue] = useState("");
  const actualValue = useRef("");
  
  useInput((input, key) => {
    if (disabled) return;
    if (key.return) {
      const trimmed = actualValue.current.trim();
      if (trimmed) {
        actualValue.current = "";
        setDisplayValue("");
        onSubmit(trimmed);
      }
      return;
    }
    if (key.backspace || key.delete) {
      actualValue.current = actualValue.current.slice(0, -1);
    } else if (!key.ctrl && !key.meta && input) {
      actualValue.current += input;
    }
    // Only update React state periodically or use refs
    setDisplayValue(actualValue.current);
  });
  // ...
}
```

**Pros:** Reduces re-renders during typing  
**Cons:** More complex

---

### Option 4: Use Ink's `Static` Component Properly
**File:** `src/tui/MainPanel.tsx`

The chat history already uses `<Static>`, which should only render new items. However, the parent re-renders still cause flicker.

Ensure `Static` has stable keys and consider memoizing the render function:

```typescript
const renderLine = useCallback((line: ChatLine) => (
  <Box key={line.id}>
    <Text ...>{line.text}</Text>
  </Box>
), []);  // Stable callback

<Static items={messages}>
  {renderLine}
</Static>
```

---

### Option 5: Optimize DiffViewer Rendering
**File:** `src/tui/DiffViewer.tsx`

The diff viewer re-parses and filters lines on every render:

```typescript
const lines = diff.patch.split("\n").slice(2);  // Runs every render

// ...
{lines.filter(l => ...).map((line, i) => {  // Filter runs every render
```

Memoize with `useMemo`:

```typescript
const lines = useMemo(() => 
  diff.patch.split("\n").slice(2).filter(l => ...),
  [diff.patch]
);
```

---

## Recommended Fix Priority

1. **Immediate (Low effort, high impact):**
   - Increase spinner interval to 200ms in `MainPanel.tsx`
   - Add `useMemo` to `DiffViewer` line filtering

2. **Short-term (Medium effort, high impact):**
   - Implement batching in `store.ts` dispatch

3. **Long-term (Higher effort, medium impact):**
   - Optimize `InputBar` with refs or uncontrolled input
   - Profile with React DevTools to identify remaining hot paths

## Testing Fixes

To verify improvements:

```bash
# Run TUI and observe during:
# 1. Typing in input
# 2. Agent processing (spinner active)
# 3. Diff viewing

npm run build
node dist/cli/index.js chat
```

Look for:
- Smooth cursor movement during typing
- Stable spinner without surrounding content jitter
- No "tearing" or flashing of the sidebar/chat history
