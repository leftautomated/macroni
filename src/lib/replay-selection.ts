const STORAGE_KEY = "macroni-replay-recording-selection";
const CHANNEL_NAME = "macroni-replay-selection";

type SelectionListener = (recordingId: string) => void;

const listeners = new Set<SelectionListener>();
let channel: BroadcastChannel | null = null;

function validRecordingId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function notify(recordingId: string) {
  for (const listener of listeners) listener(recordingId);
}

function getChannel() {
  if (channel || typeof window === "undefined" || !("BroadcastChannel" in window)) {
    return channel;
  }

  channel = new window.BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener("message", (event) => {
    if (validRecordingId(event.data)) notify(event.data);
  });
  return channel;
}

export function readReplaySelection(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const recordingId = window.localStorage.getItem(STORAGE_KEY);
    return validRecordingId(recordingId) ? recordingId : null;
  } catch {
    return null;
  }
}

export function publishReplaySelection(recordingId: string) {
  if (!validRecordingId(recordingId)) return;

  try {
    window.localStorage.setItem(STORAGE_KEY, recordingId);
  } catch {
    // BroadcastChannel still provides live synchronization when storage is unavailable.
  }
  getChannel()?.postMessage(recordingId);
  notify(recordingId);
}

export function subscribeReplaySelection(listener: SelectionListener) {
  let lastDelivered: string | null = null;
  const deliver: SelectionListener = (recordingId) => {
    if (recordingId === lastDelivered) return;
    lastDelivered = recordingId;
    listener(recordingId);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY && validRecordingId(event.newValue)) {
      deliver(event.newValue);
    }
  };

  listeners.add(deliver);
  getChannel();
  window.addEventListener("storage", onStorage);

  const storedSelection = readReplaySelection();
  if (storedSelection) deliver(storedSelection);

  return () => {
    listeners.delete(deliver);
    window.removeEventListener("storage", onStorage);
  };
}
