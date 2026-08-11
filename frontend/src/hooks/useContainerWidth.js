import { useEffect, useRef, useState } from "react";

// Measures a container's real rendered width so an SVG chart's viewBox can be
// set 1:1 with actual CSS pixels — keeping font-size a true, legible size at
// any screen width, rather than shrinking proportionally the way a
// fixed-viewBox SVG scaled via width:100% would (illegible axis labels on
// narrow phones). Shared by every SVG chart in the app (RevenueTrendChart,
// BarChart) so they all get this fix consistently.
export default function useContainerWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w) setWidth(w);
    });
    observer.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
