import { useEffect, RefObject } from "react";
import { useWindowResize } from "./useWindow";

interface UseAutoResizeOptions {
  isExpanded: boolean;
  headerRef: RefObject<HTMLElement | null> | RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLElement | null> | RefObject<HTMLDivElement | null>;
  dependencies?: unknown[];
}

export const useAutoResize = ({
  isExpanded,
  headerRef,
  contentRef,
  dependencies = [],
}: UseAutoResizeOptions) => {
  const { resizeWindow } = useWindowResize();

  useEffect(() => {
    if (!isExpanded) {
      // Collapsed: measure header width and use default height
      const updateCollapsedSize = () => {
        if (headerRef.current) {
          const headerWidth = headerRef.current.offsetWidth;
          const headerHeight = headerRef.current.offsetHeight;
          // Add padding: mx-2 (8px each side) = 16px total for width
          // Add padding: pt-4 (16px) + pb-4 (16px) = 32px total for height
          const totalWidth = headerWidth + 16;
          const totalHeight = headerHeight + 16; // pt-4 + pb-4
          resizeWindow(Math.max(400, totalWidth), totalHeight);
        } else {
          resizeWindow(700, 60);
        }
      };

      // Initial resize
      updateCollapsedSize();

      // Watch header for width changes
      const observer = new ResizeObserver(() => {
        updateCollapsedSize();
      });

      if (headerRef.current) {
        observer.observe(headerRef.current);
      }

      return () => {
        observer.disconnect();
      };
    }

    const updateSize = () => {
      if (!contentRef.current) return;
      
      // Measure actual content dimensions
      const contentHeight = contentRef.current.scrollHeight;
      const contentWidth = contentRef.current.scrollWidth;
      
      // Calculate total dimensions
      // Padding: pt-4 (16px) + pb-4 (16px) = 32px
      // Header: ~60px (increased from 42px)
      // Gap: 12px
      const totalHeight = 60 + 12 + contentHeight + 32;
      
      // Width: content width + mx-2 padding (16px total)
      const totalWidth = Math.max(400, contentWidth + 16);
      
      resizeWindow(totalWidth, totalHeight);
    };

    // Initial resize
    updateSize();

    // Use ResizeObserver to watch for content changes
    const observer = new ResizeObserver(() => {
      updateSize();
    });

    if (contentRef.current) {
      observer.observe(contentRef.current);
    }

    // Also observe header for width changes
    if (headerRef.current) {
      observer.observe(headerRef.current);
    }

    return () => {
      observer.disconnect();
    };
  }, [isExpanded, resizeWindow, ...dependencies]);
};

