import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { ArrowReset20Regular, Crop20Regular } from "@fluentui/react-icons";
import type { SpaceAppearanceBannerFraming } from "../../../../src/shared/space-appearance";
import { spaceBannerImageStyle, spaceIdentityStyle, type SpaceIdentity } from "../../lib/space-identity";

export function SpaceBannerPreview({ identity, name, onFrame, editable = true }: {
  identity: SpaceIdentity;
  name: string;
  onFrame: (framing: SpaceAppearanceBannerFraming) => void;
  editable?: boolean;
}) {
  const [frame, setFrame] = useState(identity.bannerFraming);
  const frameRef = useRef(frame);
  const savedRef = useRef(identity.bannerFraming);
  const adjusting = useRef(false);
  const [framingOpen, setFramingOpen] = useState(false);
  const framingRef = useRef<HTMLDivElement>(null);
  const framingButtonRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; frame: SpaceAppearanceBannerFraming; overflowX: number; overflowY: number } | null>(null);
  const source = `${identity.bannerImage}:${JSON.stringify(identity.bannerFraming)}`;
  useEffect(() => {
    frameRef.current = identity.bannerFraming;
    savedRef.current = identity.bannerFraming;
    setFrame(identity.bannerFraming);
    adjusting.current = false;
    drag.current = null;
  }, [source]);
  useEffect(() => {
    if (!editable || !identity.bannerImage) setFramingOpen(false);
  }, [editable, identity.bannerImage]);
  useEffect(() => {
    if (!framingOpen) return;
    framingRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    function outside(event: globalThis.PointerEvent) {
      if (event.target instanceof Node && !framingRef.current?.contains(event.target) && !framingButtonRef.current?.contains(event.target)) setFramingOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setFramingOpen(false);
      framingButtonRef.current?.focus();
    }
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [framingOpen]);

  function change(next: SpaceAppearanceBannerFraming) {
    frameRef.current = next;
    setFrame(next);
  }
  function commit() {
    adjusting.current = false;
    if (JSON.stringify(frameRef.current) === JSON.stringify(savedRef.current)) return;
    savedRef.current = frameRef.current;
    onFrame(frameRef.current);
  }
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (!editable || !identity.bannerImage || event.button !== 0) return;
    const image = event.currentTarget.querySelector("img")!;
    if (!image.naturalWidth || !image.naturalHeight) return;
    const box = event.currentTarget.getBoundingClientRect();
    const scale = Math.max(box.width / image.naturalWidth, box.height / image.naturalHeight) * frame.zoom;
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, frame, overflowX: Math.max(0, image.naturalWidth * scale - box.width), overflowY: Math.max(0, image.naturalHeight * scale - box.height) };
    adjusting.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    event.preventDefault();
  }
  const bounded = (value: number) => Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;

  return <div className="space-preview-region">
    <div className="space-appearance-previews" aria-label="Light and dark work-folder previews">
      {(["light", "dark"] as const).map((mode) => <div key={mode}>
        <span className="space-preview-mode-label">{mode === "light" ? "Light" : "Dark"}</span>
        <div
          className={["space-appearance-preview", "space-banner-surface", `preview-${mode}`, `banner-${identity.bannerName}`, identity.bannerImage ? "has-banner-image" : "", editable && identity.bannerImage ? "is-framing" : "", identity.bannerPreset ? "has-banner-preset" : ""].filter(Boolean).join(" ")}
          style={{ ...spaceIdentityStyle(identity, mode), colorScheme: mode } as CSSProperties}
          data-preview-mode={mode}
          tabIndex={editable && identity.bannerImage ? 0 : undefined}
          role={editable && identity.bannerImage ? "group" : undefined}
          aria-label={editable && identity.bannerImage ? `${mode === "light" ? "Light" : "Dark"} banner framing. Drag or use arrow keys to reposition.` : undefined}
          onPointerDown={startDrag}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start || start.pointer !== event.pointerId) return;
            change({ ...start.frame, x: start.overflowX > 0 ? bounded(start.frame.x - (event.clientX - start.x) / start.overflowX * 100) : start.frame.x, y: start.overflowY > 0 ? bounded(start.frame.y - (event.clientY - start.y) / start.overflowY * 100) : start.frame.y });
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointer !== event.pointerId) return;
            drag.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
            commit();
          }}
          onPointerCancel={() => { drag.current = null; adjusting.current = false; change(savedRef.current); }}
          onKeyDown={(event) => {
            if (!editable || !identity.bannerImage || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            const step = event.shiftKey ? 10 : 2;
            change({ ...frameRef.current, x: bounded(frameRef.current.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0)), y: bounded(frameRef.current.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0)) });
            commit();
          }}
        >
          {identity.bannerImage ? <span className="space-appearance-preview-image" aria-hidden="true"><img src={identity.bannerImage} alt="" draggable={false} style={spaceBannerImageStyle(frame)} /><span /></span> : null}
          <span className="space-appearance-preview-copy"><strong>{name}</strong></span>
        </div>
      </div>)}
    </div>
    <button ref={framingButtonRef} type="button" className="space-framing-trigger" disabled={!identity.bannerImage} hidden={!editable} aria-expanded={framingOpen} aria-controls="space-banner-framing" onClick={() => setFramingOpen((open) => !open)}><Crop20Regular />Adjust image</button>
    {framingOpen && editable && identity.bannerImage ? <div ref={framingRef} id="space-banner-framing" className="space-framing-popover" role="group" aria-label="Banner framing">
      <div className="space-framing-controls">
        {(["x", "y", "zoom"] as const).map((axis) => <label key={axis}>
          <span>{axis === "x" ? "Horizontal" : axis === "y" ? "Vertical" : "Zoom"}</span>
          <input type="range" min={axis === "zoom" ? 1 : 0} max={axis === "zoom" ? 2 : 100} step={axis === "zoom" ? 0.01 : 1} value={frame[axis]} aria-label={axis === "x" ? "Banner horizontal position" : axis === "y" ? "Banner vertical position" : "Banner zoom"}
            onPointerDown={() => { adjusting.current = true; }}
            onInput={(event) => { change({ ...frameRef.current, [axis]: Number(event.currentTarget.value) }); if (!adjusting.current) commit(); }}
            onPointerUp={commit} onBlur={commit}
            onPointerCancel={() => { adjusting.current = false; change(savedRef.current); }} />
        </label>)}
      </div>
      <div className="space-framing-popover-actions">
        <button type="button" aria-label="Reset banner framing" onClick={() => { change({ x: 50, y: 50, zoom: 1 }); commit(); }}><ArrowReset20Regular />Reset</button>
        <button type="button" onClick={() => { setFramingOpen(false); framingButtonRef.current?.focus(); }}>Done</button>
      </div>
    </div> : null}
  </div>;
}
