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
    <Card className="w-[390px] space-y-3 px-4 py-3 shadow-xl" aria-label="Auto clicker controls">
      <div className="flex items-center gap-2 text-sm">
        <span className="whitespace-nowrap text-muted-foreground">Click using the</span>
        <Select
          value={config.button}
          onValueChange={(button: ClickerButton) => onChange({ ...config, button })}
          disabled={controlsDisabled}
        >
          <SelectTrigger className="h-8 w-[108px]" aria-label="Mouse button">
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

      <div className="flex items-center gap-2 text-sm">
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
          className="h-8 w-[76px] tabular-nums"
        />
        <span className="whitespace-nowrap text-muted-foreground">times per</span>
        <Select
          value={config.period}
          onValueChange={(period: ClickerPeriod) => updatePeriod(period)}
          disabled={controlsDisabled}
        >
          <SelectTrigger className="h-8 w-[112px]" aria-label="Click period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="second">second</SelectItem>
            <SelectItem value="minute">minute</SelectItem>
            <SelectItem value="hour">hour</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-3 pt-0.5">
        {isIdle ? (
          <Button className="h-8 flex-1" size="sm" onClick={onStart} disabled={disabled}>
            <MousePointerClick className="mr-1.5 h-4 w-4" /> Start clicking
          </Button>
        ) : (
          <Button
            className="h-8 flex-1"
            size="sm"
            variant="destructive"
            onClick={onStop}
            disabled={status === "stopping"}
          >
            <Square className="mr-1.5 h-3 w-3" />
            {status === "stopping" ? "Stopping…" : "Stop clicking"}
          </Button>
        )}
        <span className="min-w-[138px] text-xs text-muted-foreground" aria-live="polite">
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
