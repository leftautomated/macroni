import {
  CheckCircle2,
  Eye,
  ExternalLink,
  Keyboard,
  Monitor,
  Moon,
  Palette,
  Shield,
  Sun,
  Video,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { DiagnosticsPanel } from "@/components/DiagnosticsPanel";
import { useTheme } from "@/components/theme-provider";
import { useAppSettings } from "@/hooks/useAppSettings";
import { usePermissionStatus } from "@/hooks/usePermissionStatus";
import type { CaptureQuality, CaptureSettings } from "@/types";

const isMac = navigator.userAgent.includes("Mac");
const isWindows = navigator.userAgent.includes("Win");
const mod = isMac ? "⌘" : "Ctrl";

const SHORTCUTS = [
  { keys: `${mod} + Shift + R`, description: "Start / stop recording" },
  { keys: `${mod} + R`, description: "Start / stop playback" },
  { keys: `${mod} + M`, description: "Hide / show window" },
] as const;

const FPS_OPTIONS: Array<15 | 30 | 60> = [15, 30, 60];
const QUALITY_OPTIONS: CaptureQuality[] = ["low", "med", "high"];
const QUALITY_LABELS: Record<CaptureQuality, string> = { low: "Low", med: "Med", high: "High" };

export const SettingsTab = () => {
  const { setTheme, theme } = useTheme();
  const { settings, update } = useAppSettings();
  const perms = usePermissionStatus();

  const setCapture = (partial: Partial<CaptureSettings>) => {
    if (!settings) return;
    update({ ...settings, capture: { ...settings.capture, ...partial } });
  };

  return (
    <div className="st-root">
      <style>{`
        .st-root { display: flex; flex-direction: column; gap: 26px; padding-bottom: 8px; }
        .st-section { display: flex; flex-direction: column; gap: 9px; }
        .st-label {
          display: flex; align-items: center; gap: 7px;
          padding-left: 3px;
          font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
          color: rgba(255,255,255,0.42);
        }
        .st-label svg { width: 13px; height: 13px; }
        .st-panel {
          border: 1px solid rgba(255,255,255,0.07);
          background: rgba(255,255,255,0.025);
          border-radius: 12px;
          overflow: hidden;
        }
        .st-row {
          display: flex; align-items: center; justify-content: space-between; gap: 16px;
          padding: 11px 14px; min-height: 46px; box-sizing: border-box;
        }
        .st-row + .st-row { border-top: 1px solid rgba(255,255,255,0.06); }
        .st-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .st-row-label { font-size: 13px; color: rgba(255,255,255,0.86); }
        .st-row-desc { font-size: 11.5px; line-height: 1.45; color: rgba(255,255,255,0.45); }
        .st-note { font-size: 12px; line-height: 1.5; color: rgba(255,255,255,0.5); padding: 0 3px; }
        .st-note strong { color: rgba(255,255,255,0.82); font-weight: 500; }

        .st-seg {
          display: inline-flex; gap: 2px; padding: 2px; flex-shrink: 0;
          background: rgba(0,0,0,0.28);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 8px;
        }
        .st-seg-btn {
          appearance: none; border: none; background: transparent; cursor: pointer;
          display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
          font: inherit; font-size: 12px; font-weight: 500;
          color: rgba(255,255,255,0.6);
          padding: 5px 11px; border-radius: 6px;
          transition: background 120ms ease, color 120ms ease;
        }
        .st-seg-btn svg { width: 13px; height: 13px; }
        .st-seg-btn:hover:not(.active) { color: rgba(255,255,255,0.92); background: rgba(255,255,255,0.05); }
        .st-seg-btn.active {
          background: #6366f1; color: #fff;
          box-shadow: 0 1px 2px rgba(0,0,0,0.28);
        }

        .st-switch {
          position: relative; flex-shrink: 0;
          width: 38px; height: 22px; padding: 0; border: none; border-radius: 999px;
          background: rgba(255,255,255,0.16); cursor: pointer;
          transition: background 140ms ease;
        }
        .st-switch.on { background: #6366f1; }
        .st-knob {
          position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
          border-radius: 50%; background: #fff;
          box-shadow: 0 1px 2px rgba(0,0,0,0.35);
          transition: transform 140ms cubic-bezier(0.2,0.8,0.2,1);
        }
        .st-switch.on .st-knob { transform: translateX(16px); }

        .st-keys { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; }
        .st-kbd {
          display: inline-flex; align-items: center; justify-content: center;
          min-width: 21px; height: 22px; padding: 0 7px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px; font-weight: 500; color: rgba(255,255,255,0.82);
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.09);
          border-bottom-color: rgba(0,0,0,0.32);
          border-radius: 5px;
        }
        .st-kbd-plus { color: rgba(255,255,255,0.3); font-size: 11px; }

        .st-perm { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
        .st-perm-dot { flex-shrink: 0; width: 15px; height: 15px; }
        .st-perm-dot.ok { color: #34d399; }
        .st-perm-dot.no { color: #f87171; }
        .st-perm-sub { font-size: 11.5px; color: rgba(255,255,255,0.42); }

        .st-btn {
          display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
          font: inherit; font-size: 12px; font-weight: 500; color: rgba(255,255,255,0.82);
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1); border-radius: 7px;
          padding: 5px 10px; cursor: pointer;
          transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .st-btn svg { width: 13px; height: 13px; }
        .st-btn:hover { background: rgba(255,255,255,0.09); color: #fff; border-color: rgba(255,255,255,0.18); }
        .st-btn:disabled { opacity: 0.5; cursor: default; }
      `}</style>

      {/* Capture */}
      <Section icon={<Video />} label="Capture">
        {isWindows && (
          <p className="st-note">
            Video capture is temporarily unavailable on Windows (upstream library issue). Event
            recording still works — these settings apply once video support ships.
          </p>
        )}
        <div className="st-panel">
          {settings ? (
            <>
              <div className="st-row">
                <span className="st-row-label">Frame rate</span>
                <div className="st-seg">
                  {FPS_OPTIONS.map((fps) => (
                    <button
                      key={fps}
                      type="button"
                      className={`st-seg-btn${settings.capture.fps === fps ? " active" : ""}`}
                      aria-pressed={settings.capture.fps === fps}
                      onClick={() => setCapture({ fps })}
                    >
                      {fps}
                    </button>
                  ))}
                </div>
              </div>
              <div className="st-row">
                <span className="st-row-label">Quality</span>
                <div className="st-seg">
                  {QUALITY_OPTIONS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className={`st-seg-btn${settings.capture.quality === q ? " active" : ""}`}
                      aria-pressed={settings.capture.quality === q}
                      onClick={() => setCapture({ quality: q })}
                    >
                      {QUALITY_LABELS[q]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="st-row">
                <div className="st-row-main">
                  <span className="st-row-label">System audio</span>
                  <span className="st-row-desc">Capture audio playing on this device</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.capture.audio}
                  aria-label="Capture system audio"
                  className={`st-switch${settings.capture.audio ? " on" : ""}`}
                  onClick={() => setCapture({ audio: !settings.capture.audio })}
                >
                  <span className="st-knob" />
                </button>
              </div>
            </>
          ) : (
            <div className="st-row">
              <span className="st-row-desc">Loading…</span>
            </div>
          )}
        </div>
      </Section>

      {/* Perception */}
      <Section icon={<Eye />} label="Perception">
        <div className="st-panel">
          {settings ? (
            <div className="st-row">
              <div className="st-row-main">
                <span className="st-row-label">Continuous text scan while recording</span>
                <span className="st-row-desc">
                  OCRs the screen ~1×/sec during recording to build a searchable text timeline.
                  Stored as plain text with the recording — leave off if you record sensitive
                  content.
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.perception.continuous_ocr}
                aria-label="Continuous text scan while recording"
                className={`st-switch${settings.perception.continuous_ocr ? " on" : ""}`}
                onClick={() =>
                  update({
                    ...settings,
                    perception: { continuous_ocr: !settings.perception.continuous_ocr },
                  })
                }
              >
                <span className="st-knob" />
              </button>
            </div>
          ) : (
            <div className="st-row">
              <span className="st-row-desc">Loading…</span>
            </div>
          )}
        </div>
      </Section>

      {/* Appearance */}
      <Section icon={<Palette />} label="Appearance">
        <div className="st-panel">
          <div className="st-row">
            <span className="st-row-label">Theme</span>
            <div className="st-seg">
              <SegIcon active={theme === "light"} onClick={() => setTheme("light")} label="Light">
                <Sun />
              </SegIcon>
              <SegIcon active={theme === "dark"} onClick={() => setTheme("dark")} label="Dark">
                <Moon />
              </SegIcon>
              <SegIcon
                active={theme === "system"}
                onClick={() => setTheme("system")}
                label="System"
              >
                <Monitor />
              </SegIcon>
            </div>
          </div>
        </div>
      </Section>

      {/* Keyboard shortcuts */}
      <Section icon={<Keyboard />} label="Keyboard Shortcuts">
        <div className="st-panel">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="st-row">
              <span className="st-row-label">{s.description}</span>
              <ShortcutKeys keys={s.keys} />
            </div>
          ))}
        </div>
      </Section>

      {/* Permissions */}
      <Section icon={<Shield />} label="Permissions">
        <p className="st-note">
          Macroni needs <strong>Accessibility</strong> permission to capture keyboard and mouse
          input
          {isMac ? (
            <>
              {" and "}
              <strong>Screen Recording</strong> permission to capture screen video.
            </>
          ) : (
            "."
          )}
        </p>
        {isMac && (
          <div className="st-panel">
            <PermissionRow
              label="Accessibility"
              granted={perms.state.accessibility}
              onOpen={() => void perms.openAccessibilitySettings()}
            />
            <PermissionRow
              label="Screen Recording"
              granted={perms.state.screenRecording}
              onOpen={() => void perms.openScreenRecordingSettings()}
            />
          </div>
        )}
      </Section>

      {/* Diagnostics */}
      <DiagnosticsPanel />
    </div>
  );
};

function Section({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="st-section">
      <div className="st-label">
        {icon}
        {label}
      </div>
      {children}
    </section>
  );
}

function SegIcon({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`st-seg-btn${active ? " active" : ""}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
      {label}
    </button>
  );
}

function ShortcutKeys({ keys }: { keys: string }) {
  const parts = keys.split(" + ");
  return (
    <span className="st-keys">
      {parts.map((part, i) => (
        <span key={`${part}-${i}`} className="st-keys">
          {i > 0 && <span className="st-kbd-plus">+</span>}
          <kbd className="st-kbd">{part}</kbd>
        </span>
      ))}
    </span>
  );
}

function PermissionRow({
  label,
  granted,
  onOpen,
}: {
  label: string;
  granted: boolean | null;
  onOpen: () => void;
}) {
  return (
    <div className="st-row">
      <span className="st-perm">
        {granted === null ? (
          <CheckCircle2 className="st-perm-dot" style={{ opacity: 0.35 }} />
        ) : granted ? (
          <CheckCircle2 className="st-perm-dot ok" />
        ) : (
          <XCircle className="st-perm-dot no" />
        )}
        <span className="st-row-label">{label}</span>
        <span className="st-perm-sub">
          {granted === null ? "Checking…" : granted ? "Granted" : "Not granted"}
        </span>
      </span>
      <button type="button" className="st-btn" onClick={onOpen}>
        <ExternalLink /> Open
      </button>
    </div>
  );
}
