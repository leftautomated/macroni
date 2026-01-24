import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { InputEvent } from "@/types";

export const useInputEventListener = (onEvent: (event: InputEvent) => void) => {
  useEffect(() => {
    const unlisten = listen<InputEvent>("input-event", (event) => {
      onEvent(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [onEvent]);
};

