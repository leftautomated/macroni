import { useEffect, RefObject } from "react";

export const useAutoScrollToBottom = <T,>(
  scrollRef: RefObject<HTMLElement | null>,
  dependencies: T[]
) => {
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRef, dependencies.length]);
};

