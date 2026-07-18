import { MousePointerClick, Square } from "lucide-react";
import type {
  ClickerButton,
  ClickerConfig,
  ClickerPeriod,
  ClickerStatus,
} from "@/hooks/useClicker";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ClickerPanelProps {
  config: ClickerConfig;
  disabled?: boolean;
  error: string | null;
  onChange: (config: ClickerConfig) => void;
  onStart: () => void;
  onStop: () => void;
  status: ClickerStatus;
}

const MAX_CLICKS: Record<ClickerPeriod, number> = {
  second: 100,
  minute: 6_000,
  hour: 360_000,
};

export function ClickerPanel({
  config,
  disabled = false,
  error,
  onChange,
  onStart,
  onStop,
  status,
}: ClickerPanelProps) {
  const isIdle = status === "idle";
  const controlsDisabled = !isIdle;

  const updatePeriod = (period: ClickerPeriod) => {
    onChange({
      ...config,
      clicksPerPeriod: Math.min(config.clicksPerPeriod, MAX_CLICKS[period]),
      period,
    });
  };

  return (
    <Card className="w-[340px] space-y-2 px-3 py-2.5 shadow-xl" aria-label="Auto clicker controls">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="whitespace-nowrap text-muted-foreground">Click using the</span>
        <Select
          value={config.button}
          onValueChange={(button: ClickerButton) => onChange({ ...config, button })}
          disabled={controlsDisabled}
        >
          <SelectTrigger className="h-7 w-[92px] px-2.5 text-xs" aria-label="Mouse button">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left">Left</SelectItem>
            <SelectItem value="right">Right</SelectItem>
            <SelectItem value="middle">Middle</SelectItem>
          </SelectContent>
        </Select>
        <span className="whitespace-nowrap text-muted-foreground">mouse button</span>
      </div>

      <div className="flex items-center gap-1.5 text-xs">
        <span className="whitespace-nowrap text-muted-foreground">Click</span>
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_CLICKS[config.period]}
          value={config.clicksPerPeriod}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isFinite(next)) return;
            onChange({
              ...config,
              clicksPerPeriod: Math.max(1, Math.min(Math.trunc(next), MAX_CLICKS[config.period])),
            });
          }}
          disabled={controlsDisabled}
          aria-label={`Clicks per ${config.period}`}
          className="h-7 w-[64px] px-2.5 text-xs tabular-nums"
        />
        <span className="whitespace-nowrap text-muted-foreground">times per</span>
        <Select
          value={config.period}
          onValueChange={(period: ClickerPeriod) => updatePeriod(period)}
          disabled={controlsDisabled}
        >
          <SelectTrigger className="h-7 w-[96px] px-2.5 text-xs" aria-label="Click period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="second">second</SelectItem>
            <SelectItem value="minute">minute</SelectItem>
            <SelectItem value="hour">hour</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        {isIdle ? (
          <Button className="h-7 flex-1 text-xs" size="sm" onClick={onStart} disabled={disabled}>
            <MousePointerClick className="mr-1.5 h-3.5 w-3.5" /> Start clicking
          </Button>
        ) : (
          <Button
            className="h-7 flex-1 text-xs"
            size="sm"
            variant="destructive"
            onPointerDown={onStop}
            onClick={(event) => {
              // Stop on press so an injected auto-click cancels the worker
              // before its matching release can click this control again.
              // Keyboard activation has no pointer-down, so retain its native
              // click path (detail === 0).
              if (event.detail === 0) onStop();
            }}
            disabled={status === "stopping"}
          >
            <Square className="mr-1.5 h-3 w-3" />
            {status === "stopping" ? "Stopping…" : "Stop clicking"}
          </Button>
        )}
        <span
          className="min-w-[116px] text-[11px] leading-4 text-muted-foreground"
          aria-live="polite"
        >
          {status === "arming" && "Starts in 3 seconds…"}
          {status === "running" && "Clicking now"}
          {status === "stopping" && "Finishing the current click…"}
          {isIdle && disabled && "Stop the current task first"}
          {isIdle && !disabled && "Move the cursor after Start"}
        </span>
      </div>

      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}
