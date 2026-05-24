import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

interface SystemDiagramPageProps {
  onClose: () => void;
}

export default function SystemDiagramPage({ onClose }: SystemDiagramPageProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const pointerId = useRef<number | null>(null);
  const startPoint = useRef({ x: 0 });
  const startOffset = useRef(0);
  const [offsetX, setOffsetX] = useState(0);
  const minXRef = useRef(0);
  const velocityRef = useRef(0); // px per ms
  const lastMoveTimeRef = useRef<number | null>(null);
  const lastClientXRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const onPointerDown = useCallback((event: PointerEvent<HTMLImageElement>) => {
    if (!imageRef.current) return;
    dragging.current = true;
    pointerId.current = event.pointerId;
    startPoint.current = { x: event.clientX };
    startOffset.current = offsetX;
    try { imageRef.current.setPointerCapture(event.pointerId); } catch {}
    // stop any inertia animation
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    lastMoveTimeRef.current = performance.now();
    lastClientXRef.current = event.clientX;
  }, [offsetX]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || pointerId.current !== event.pointerId) return;
    const now = performance.now();
    const dx = event.clientX - startPoint.current.x;
    const next = startOffset.current + dx;
    const clamped = Math.max(minXRef.current, Math.min(0, next));
    setOffsetX(clamped);
    // velocity tracking (px per ms)
    const lastTime = lastMoveTimeRef.current;
    const lastX = lastClientXRef.current;
    if (lastTime != null && lastX != null) {
      const dt = Math.max(1, now - lastTime);
      const vx = (event.clientX - lastX) / dt;
      velocityRef.current = vx;
    }
    lastMoveTimeRef.current = now;
    lastClientXRef.current = event.clientX;
  }, []);

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    dragging.current = false;
    pointerId.current = null;
    lastMoveTimeRef.current = null;
    lastClientXRef.current = null;
    // start inertia
    const step = (t: number) => {
      let last = performance.now();
      const loop = (now: number) => {
        const dt = Math.max(1, now - last);
        last = now;
        // apply velocity
        let v = velocityRef.current;
        // apply position
        setOffsetX((cur) => {
          let next = cur + v * dt;
          // clamp
          if (next > 0) { next = 0; v = 0; }
          if (next < minXRef.current) { next = minXRef.current; v = 0; }
          return next;
        });
        // apply friction
        const decay = 0.95;
        velocityRef.current = v * Math.pow(decay, dt / 16.67);
        if (Math.abs(velocityRef.current) > 0.02) {
          rafRef.current = requestAnimationFrame(loop);
        } else {
          rafRef.current = null;
        }
      };
      rafRef.current = requestAnimationFrame(loop);
    };
    // small delay to start step to allow last velocity to be set
    step(performance.now());
  }, []);

  const computeBounds = useCallback(() => {
    const img = imageRef.current;
    const frame = frameRef.current;
    if (!img || !frame) return;
    const imgRect = img.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const minX = Math.min(0, frameRect.width - imgRect.width);
    minXRef.current = minX;
    setOffsetX((x) => Math.max(minXRef.current, Math.min(0, x)));
  }, []);

  useEffect(() => {
    computeBounds();
    const onResize = () => computeBounds();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [computeBounds]);

  return (
    <div className="system-diagram-page">
      <div className="system-diagram-shell">
        <button className="system-diagram-close" onClick={onClose}>
          ← Back
        </button>
        <div
          ref={frameRef}
          className="system-diagram-frame"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <img
            ref={imageRef}
            className="system-diagram-image"
            src="/system-diagram.jpg"
            alt="System Diagram"
            onPointerDown={onPointerDown}
            onLoad={computeBounds}
            style={{ transform: `translateX(${offsetX}px)` }}
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}
