import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import type { TranscriptionEvent } from "../types";
import { useQueue } from "./useQueue";

const TRANSCRIPTION_EVENT_NAME = "transcription-event";

export function useTauriEvents(): void {
  const handleEvent = useQueue((state) => state.handleEvent);

  useEffect(() => {
    let isMounted = true;
    let cleanup: (() => void) | undefined;

    void listen<TranscriptionEvent>(TRANSCRIPTION_EVENT_NAME, (event) => {
      handleEvent(event.payload);
    })
      .then((unlisten) => {
        if (!isMounted) {
          unlisten();
          return;
        }

        cleanup = unlisten;
      })
      .catch((error: unknown) => {
        console.warn("[tauri-events] failed to subscribe to transcription-event", error);
      });

    return () => {
      isMounted = false;
      cleanup?.();
    };
  }, [handleEvent]);
}
