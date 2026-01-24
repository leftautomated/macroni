import { useEffect, RefObject } from "react";
import { UI_CONFIG } from "@/config";

export const useAutoScroll = (
  currentPosition: number | null,
  rowRefs: RefObject<Map<number, HTMLElement>>
) => {
  useEffect(() => {
    if (currentPosition === null) return;
    
    const timeoutId = setTimeout(() => {
      const row = rowRefs.current?.get(currentPosition);
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, UI_CONFIG.SCROLL_THROTTLE_MS);
    
    return () => clearTimeout(timeoutId);
  }, [currentPosition, rowRefs]);
};

