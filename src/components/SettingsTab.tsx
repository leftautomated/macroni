import {
  AlertCircle,
  CheckCircle2,
  Download,
  Eye,
  ExternalLink,
  Keyboard,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Shield,
  Sun,
  Video,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { DiagnosticsPanel } from "@/components/DiagnosticsPanel";
import { useTheme } from "@/components/theme-provider";
import { useAppSettings } from "@/hooks/useAppSettings";
import { useAppUpdater } from "@/hooks/useAppUpdater";
import { usePermissionStatus } from "@/hooks/usePermissionStatus";
import type { CaptureQuality, CaptureSettings } from "@/types";

const isMac = navigator.userAgent.includes("Mac");
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
  const updater = useAppUpdater();
  const perms = usePermissionStatus();

  const setCapture = (partial: Partial<CaptureSettings>) => {
    if (!settings) return;
    update({ ...settings, capture: { ...settings.capture, ...partial } });
  };

  const toggleCaptureVideo = () => {
    if (!settings) return;
    const video = !settings.capture.video;
    update({
      ...settings,
      capture: { ...settings.capture, video },
      perception: video ? settings.perception : { ...settings.perception, continuous_ocr: false },
    });
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
          color: var(--studio-text-subtle);
        }
        .st-label svg { width: 13px; height: 13px; color: var(--studio-accent); }
        .st-panel {
          border: 1px solid var(--studio-border);
          background: var(--studio-surface-soft);
          border-radius: 12px;
          overflow: hidden;
        }
        .st-row {
          display: flex; align-items: center; justify-content: space-between; gap: 16px;
          padding: 11px 14px; min-height: 46px; box-sizing: border-box;
        }
        .st-row + .st-row { border-top: 1px solid var(--studio-border); }
        .st-row.is-disabled .st-row-label, .st-row.is-disabled .st-row-desc { opacity: 0.56; }
        .st-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .st-row-label { font-size: 13px; color: var(--studio-text-strong); }
        .st-row-desc { font-size: 11.5px; line-height: 1.45; color: var(--studio-text-subtle); }
        .st-note { font-size: 12px; line-height: 1.5; color: var(--studio-text-muted); padding: 0 3px; }
        .st-note strong { color: var(--studio-text-strong); font-weight: 500; }

        .st-seg {
          display: inline-flex; gap: 2px; padding: 2px; flex-shrink: 0;
          background: var(--studio-control);
          border: 1px solid var(--studio-border);
          border-radius: 8px;
        }
        .st-seg-btn {
          appearance: none; border: none; background: transparent; cursor: pointer;
          display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
          font: inherit; font-size: 12px; font-weight: 500;
          color: var(--studio-text-muted);
          padding: 5px 11px; border-radius: 6px;
          transition: background 120ms ease, color 120ms ease;
        }
        .st-seg-btn svg { width: 13px; height: 13px; }
        .st-seg-btn:hover:not(.active) { color: var(--studio-text-strong); background: var(--studio-hover); }
        .st-seg-btn:disabled { cursor: default; opacity: 0.5; }
        .st-seg-btn:disabled:hover { color: var(--studio-text-muted); background: transparent; }
        .st-seg-btn.active {
          background: var(--studio-accent-fill); color: #17130a;
          box-shadow: 0 1px 2px rgba(0,0,0,0.28);
        }

        .st-switch {
          position: relative; flex-shrink: 0;
          width: 38px; height: 22px; padding: 0; border: none; border-radius: 999px;
          background: var(--studio-border-strong); cursor: pointer;
          transition: background 140ms ease;
        }
        .st-switch.on { background: var(--studio-accent-fill); }
        .st-switch:disabled { cursor: default; opacity: 0.5; }
        .st-knob {
          position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
          border-radius: 50%; background: #fff;
          box-shadow: 0 1px 2px rgba(0,0,0,0.35);
          transition: transform 140ms cubic-bezier(0.2,0.8,0.2,1);
        }
        .st-switch.on .st-knob { transform: translateX(16px); background: #000; }

        .st-keys { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; }
        .st-kbd {
          display: inline-flex; align-items: center; justify-content: center;
          min-width: 21px; height: 22px; padding: 0 7px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px; font-weight: 500; color: var(--studio-text-strong);
          background: var(--studio-hover);
          border: 1px solid var(--studio-border);
          border-bottom-color: var(--studio-border-strong);
          border-radius: 5px;
          box-shadow: inset 0 -1px 0 rgba(0,0,0,0.24), 0 1px 1px rgba(0,0,0,0.28);
        }
        .st-kbd-plus { color: var(--studio-text-subtle); font-size: 11px; }

        .st-perm { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
        .st-perm-dot { flex-shrink: 0; width: 15px; height: 15px; }
        .st-perm-dot.ok { color: var(--studio-success); }
        .st-perm-dot.no { color: var(--studio-danger); }
        .st-perm-sub { font-size: 11.5px; color: var(--studio-text-subtle); }

        .st-btn {
          display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
          font: inherit; font-size: 12px; font-weight: 500; color: var(--studio-text-strong);
          background: var(--studio-hover);
          border: 1px solid var(--studio-border); border-radius: 7px;
          padding: 5px 10px; cursor: pointer;
          transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .st-btn svg { width: 13px; height: 13px; }
        .st-btn:hover { background: var(--studio-accent-soft); color: var(--studio-accent); border-color: var(--studio-accent-border); }
        .st-btn:disabled { opacity: 0.5; cursor: default; }

        .st-update { align-items: center; }
        .st-update-copy { display: flex; flex: 1; flex-direction: column; gap: 7px; min-width: 0; }
        .st-update-heading { display: flex; align-items: center; gap: 12px; min-width: 0; flex-wrap: wrap; }
        .st-update-version { color: var(--studio-text-strong); font-weight: 600; }
        .st-update-status {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 11.5px; line-height: 1.45; color: var(--studio-text-subtle);
        }
        .st-update-status svg { width: 13px; height: 13px; flex-shrink: 0; }
        .st-update-status.ok { color: var(--studio-success); }
        .st-update-status.error { color: var(--studio-danger); }
        .st-update-notes {
          max-width: 540px; margin: 3px 0 0; white-space: pre-wrap;
          font-size: 11.5px; line-height: 1.5; color: var(--studio-text-muted);
        }
        .st-update-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .st-btn.primary { color: #17130a; background: var(--studio-accent-fill); border-color: var(--studio-accent-fill); }
        .st-btn.primary:hover { color: #000; background: var(--studio-accent-fill-hover); border-color: var(--studio-accent-fill-hover); }
        .st-btn.busy svg { animation: st-spin 900ms linear infinite; }
        .st-progress {
          width: 100%; height: 4px; margin-top: 5px; overflow: hidden;
          border-radius: 999px; background: var(--studio-border);
        }
        .st-progress-fill { height: 100%; border-radius: inherit; background: var(--studio-accent-fill); transition: width 160ms ease; }
        .st-progress.indeterminate .st-progress-fill {
          width: 35%; animation: st-progress 1.1s ease-in-out infinite;
        }
        @keyframes st-spin { to { transform: rotate(360deg); } }
        @keyframes st-progress { from { transform: translateX(-120%); } to { transform: translateX(320%); } }
      `}</style>

      {/* Capture */}
      <Section icon={<Video />} label="Capture">
        <div className="st-panel">
          {settings ? (
            <>
              <div className="st-row">
                <div className="st-row-main">
                  <span className="st-row-label">Record screen video</span>
                  <span className="st-row-desc">
                    Save a screen recording with each macro. Turn off for event-only recording.
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.capture.video}
                  aria-label="Record screen video"
                  className={`st-switch${settings.capture.video ? " on" : ""}`}
                  onClick={toggleCaptureVideo}
                >
                  <span className="st-knob" />
                </button>
              </div>
              <div className="st-row">
                <span className="st-row-label">Frame rate</span>
                <div className="st-seg">
                  {FPS_OPTIONS.map((fps) => (
                    <button
                      key={fps}
                      type="button"
                      className={`st-seg-btn${settings.capture.fps === fps ? " active" : ""}`}
                      aria-pressed={settings.capture.fps === fps}
                      disabled={!settings.capture.video}
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
                      disabled={!settings.capture.video}
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
                  disabled={!settings.capture.video}
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
            <div className={`st-row${settings.capture.video ? "" : " is-disabled"}`}>
              <div className="st-row-main">
                <span className="st-row-label">Continuous text scan while recording</span>
                <span className="st-row-desc">
                  OCRs the screen ~1×/sec during recording to build a searchable text timeline.
                  Stored as plain text with the recording — leave off if you record sensitive
                  content. Requires screen video.
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.capture.video && settings.perception.continuous_ocr}
                aria-label="Continuous text scan while recording"
                className={`st-switch${
                  settings.capture.video && settings.perception.continuous_ocr ? " on" : ""
                }`}
                disabled={!settings.capture.video}
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

      {/* Software update */}
      <Section icon={<RefreshCw />} label="Software Update">
        <div className="st-panel" aria-live="polite">
          <div className="st-row st-update">
            <div className="st-update-copy">
              <div className="st-update-heading">
                <span className="st-row-label">
                  Macroni {updater.currentVersion ? `v${updater.currentVersion}` : ""}
                </span>
                <UpdateStatus updater={updater} />
              </div>
              {updater.status === "available" && updater.notes && (
                <p className="st-update-notes">{updater.notes}</p>
              )}
              {(updater.status === "downloading" || updater.status === "installing") && (
                <div
                  className={`st-progress${updater.progress === null ? " indeterminate" : ""}`}
                  role="progressbar"
                  aria-label="Update download progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={updater.progress ?? undefined}
                >
                  <div
                    className="st-progress-fill"
                    style={{
                      width: updater.progress === null ? undefined : `${updater.progress}%`,
                    }}
                  />
                </div>
              )}
            </div>
            <UpdateActions updater={updater} />
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

type Updater = ReturnType<typeof useAppUpdater>;

function UpdateStatus({ updater }: { updater: Updater }) {
  if (updater.status === "checking") {
    return <span className="st-update-status">Checking for updates…</span>;
  }
  if (updater.status === "up-to-date") {
    return (
      <span className="st-update-status ok">
        <CheckCircle2 /> You’re up to date
      </span>
    );
  }
  if (updater.status === "available") {
    return (
      <span className="st-update-status">
        <span className="st-update-version">Version {updater.availableVersion}</span> is ready to
        install.
      </span>
    );
  }
  if (updater.status === "downloading") {
    return (
      <span className="st-update-status">
        Downloading update{updater.progress === null ? "…" : `… ${updater.progress}%`}
      </span>
    );
  }
  if (updater.status === "installing") {
    return <span className="st-update-status">Installing update and preparing to restart…</span>;
  }
  if (updater.status === "error") {
    return (
      <span className="st-update-status error">
        <AlertCircle /> {updater.error || "Couldn’t check for updates."}
      </span>
    );
  }
  return <span className="st-update-status">Updates are downloaded and installed securely.</span>;
}

function UpdateActions({ updater }: { updater: Updater }) {
  const busy =
    updater.status === "checking" ||
    updater.status === "downloading" ||
    updater.status === "installing";
  if (updater.status === "available" || (updater.status === "error" && updater.availableVersion)) {
    return (
      <div className="st-update-actions">
        <button
          type="button"
          className="st-btn primary"
          disabled={busy}
          onClick={() => void updater.installUpdate()}
        >
          <Download /> Update and restart
        </button>
      </div>
    );
  }
  return (
    <div className="st-update-actions">
      <button
        type="button"
        className={`st-btn${busy ? " busy" : ""}`}
        disabled={busy}
        onClick={() => void updater.checkForUpdates()}
      >
        <RefreshCw /> {updater.status === "checking" ? "Checking…" : "Check again"}
      </button>
    </div>
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
