"use client";

import { Expand, GripHorizontal, Hand, Maximize, Minimize, Scan, ZoomIn, ZoomOut } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";

interface PlateViewportProps {
  name: string;
  rows: number;
  columns: number;
  language: "zh" | "en";
  editable: boolean;
  moveMode: boolean;
  selectedWellIds: string[];
  editingToolbar: ReactNode;
  describeWell: (wellId: string) => string;
  onSelect: (wellIds: string[]) => void;
  children: ReactNode;
}

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  scrollLeft: number;
  scrollTop: number;
  base: string[];
  active: boolean;
  pan: boolean;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;
const MIN_HEIGHT = 320;
const MAX_HEIGHT = 1600;
const clampZoom = (value: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
const clampHeight = (value: number) => Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, value));

/** View-only interactions live here; assignments and undo remain in the editing session. */
export function PlateViewport({
  name, rows, columns, language, editable, moveMode, selectedWellIds, editingToolbar, describeWell, onSelect, children,
}: PlateViewportProps) {
  const viewportId = useId();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  // Start at readable size. Fitting every well on screen is an explicit overview action.
  const fitRef = useRef(false);
  const dragRef = useRef<Drag | null>(null);
  const suppressClickRef = useRef(false);
  const cancelPercentRef = useRef(false);
  const resizeRef = useRef<{ y: number; height: number } | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const [inspectedWellId, setInspectedWellId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [percent, setPercent] = useState("100");
  const [panMode, setPanMode] = useState(false);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const tr = (zh: string, en: string) => language === "zh" ? zh : en;
  const inspection = describeWell(inspectedWellId ?? selectedWellIds.at(-1) ?? "");

  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement?.contains(workspaceRef.current)));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  async function toggleFullscreen() {
    setFullscreenError(false);
    try {
      if (fullscreen) await document.exitFullscreen();
      // Keep the edit dialog and notifications in the fullscreen subtree.
      else await workspaceRef.current!.closest<HTMLElement>(".app-shell")!.requestFullscreen();
    } catch {
      setFullscreenError(true);
    }
  }

  const changeZoom = useCallback((requested: number, point?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    const grid = gridRef.current;
    if (!viewport || !grid) return;
    const next = clampZoom(requested);
    const previous = zoomRef.current;
    const bounds = grid.getBoundingClientRect();
    const viewportBounds = viewport.getBoundingClientRect();
    const anchorX = point?.x ?? viewportBounds.left + viewport.clientWidth / 2;
    const anchorY = point?.y ?? viewportBounds.top + viewport.clientHeight / 2;
    const contentX = (anchorX - bounds.left) / previous;
    const contentY = (anchorY - bounds.top) / previous;
    // Apply immediately so a burst of wheel events always reads current geometry.
    grid.style.zoom = String(next);
    const scaledBounds = grid.getBoundingClientRect();
    viewport.scrollLeft += scaledBounds.left + contentX * next - anchorX;
    viewport.scrollTop += scaledBounds.top + contentY * next - anchorY;
    zoomRef.current = next;
    setZoom(next);
    setPercent(String(Math.round(next * 100)));
  }, []);

  const fitPlate = useCallback(() => {
    const viewport = viewportRef.current;
    const grid = gridRef.current;
    if (!viewport || !grid) return;
    const style = getComputedStyle(viewport);
    const width = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const bounds = grid.getBoundingClientRect();
    const unscaledWidth = bounds.width / zoomRef.current;
    const unscaledHeight = bounds.height / zoomRef.current;
    if (!unscaledWidth || !unscaledHeight) return;
    changeZoom(Math.min(1, width / unscaledWidth, height / unscaledHeight));
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    fitRef.current = true;
  }, [changeZoom]);

  useEffect(() => {
    const viewport = viewportRef.current!;
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      setMeasuredHeight(Math.round(viewport.getBoundingClientRect().height));
      // ResizeObserver reads layout; apply the fit on the next frame to avoid
      // feedback when browser scrollbars change the available width.
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (fitRef.current) fitPlate();
      });
    });
    observer.observe(viewport);
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY || dragRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      fitRef.current = false;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      changeZoom(zoomRef.current * Math.exp(-Math.max(-150, Math.min(150, delta)) * 0.002), {
        x: event.clientX, y: event.clientY,
      });
    };
    // A native, non-passive listener prevents the page from scrolling during zoom.
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      viewport.removeEventListener("wheel", wheel);
    };
  }, [fitPlate, changeZoom, rows, columns]);

  function commitPercent() {
    if (cancelPercentRef.current) {
      cancelPercentRef.current = false;
      setPercent(String(Math.round(zoomRef.current * 100)));
      return;
    }
    const value = Number(percent.trim());
    if (!percent.trim() || !Number.isFinite(value)) {
      setPercent(String(Math.round(zoomRef.current * 100)));
      return;
    }
    fitRef.current = false;
    changeZoom(value / 100);
  }

  function inspectWell(target: EventTarget) {
    const well = (target as Element).closest<HTMLElement>("button[data-well-id]");
    setInspectedWellId(well?.dataset.wellId ?? null);
  }

  function pointInGrid(event: PointerEvent<HTMLDivElement>) {
    const bounds = gridRef.current!.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) / zoomRef.current,
      y: (event.clientY - bounds.top) / zoomRef.current,
    };
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (!panMode && (!editable || moveMode))) return;
    const point = pointInGrid(event);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: point.x, startY: point.y,
      clientX: event.clientX, clientY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
      base: event.metaKey || event.ctrlKey ? selectedWellIds : [],
      active: false,
      pan: panMode,
    };
  }

  function updateDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < 5) return;
    drag.active = true;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (drag.pan) {
      event.currentTarget.scrollLeft = drag.scrollLeft - (event.clientX - drag.clientX);
      event.currentTarget.scrollTop = drag.scrollTop - (event.clientY - drag.clientY);
      return;
    }
    const point = pointInGrid(event);
    setBox({
      left: Math.min(drag.startX, point.x), top: Math.min(drag.startY, point.y),
      width: Math.abs(point.x - drag.startX), height: Math.abs(point.y - drag.startY),
    });
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && drag.active && !drag.pan) {
      const point = pointInGrid(event);
      const left = Math.min(drag.startX, point.x);
      const top = Math.min(drag.startY, point.y);
      const right = Math.max(drag.startX, point.x);
      const bottom = Math.max(drag.startY, point.y);
      const gridBounds = gridRef.current!.getBoundingClientRect();
      const selected = new Set(drag.base);
      for (const well of gridRef.current!.querySelectorAll<HTMLButtonElement>("button[data-well-id]")) {
        const bounds = well.getBoundingClientRect();
        const x = (bounds.left + bounds.width / 2 - gridBounds.left) / zoomRef.current;
        const y = (bounds.top + bounds.height / 2 - gridBounds.top) / zoomRef.current;
        if (x >= left && x <= right && y >= top && y <= bottom) selected.add(well.dataset.wellId!);
      }
      onSelect([...selected]);
    } else if (!cancelled && !drag.active && !drag.pan && !(event.target as Element).closest("button[data-well-id]")) {
      onSelect(drag.base);
    }
    suppressClickRef.current = drag.active;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    dragRef.current = null;
    setBox(null);
  }

  return (
    <div ref={workspaceRef} className={`plate-viewport ${fullscreen ? "is-fullscreen" : ""}`} onKeyDown={(event) => {
      if (event.key === "Escape" && fullscreen) { event.stopPropagation(); void toggleFullscreen(); }
    }}>
      <div className="plate-viewport-tools">
      {editingToolbar}
      <div className="plate-view-toolbar">
        <div className="plate-view-modes" role="group" aria-label={tr("孔板操作方式", "Plate interaction mode")}>
          {fullscreen && <strong className="fullscreen-plate-name">{name}</strong>}
          <button className={`button button-quiet ${!panMode ? "active" : ""}`} type="button" aria-pressed={!panMode} onClick={() => setPanMode(false)}>
            <Scan size={14} />{tr("框选", "Select")}
          </button>
          <button className={`button button-quiet ${panMode ? "active" : ""}`} type="button" aria-pressed={panMode} onClick={() => setPanMode(true)}>
            <Hand size={14} />{tr("拖动画布", "Pan")}
          </button>
        </div>
        <div className="zoom-controls" role="group" aria-label={tr("孔板视图缩放", "Plate view zoom")}>
          <button className="icon-button" type="button" disabled={zoom <= MIN_ZOOM} aria-label={tr("缩小孔板", "Zoom out")} onClick={() => { fitRef.current = false; changeZoom(zoomRef.current - 0.1); }}><ZoomOut size={14} /></button>
          <label className="zoom-value">
            <input type="number" min="10" max="200" step="1" inputMode="numeric" value={percent} aria-label={tr("孔板缩放百分比", "Plate zoom percent")} onChange={(event) => setPercent(event.target.value)} onBlur={commitPercent} onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") { event.stopPropagation(); cancelPercentRef.current = true; event.currentTarget.blur(); }
            }} /><span>%</span>
          </label>
          <button className="icon-button" type="button" disabled={zoom >= MAX_ZOOM} aria-label={tr("放大孔板", "Zoom in")} onClick={() => { fitRef.current = false; changeZoom(zoomRef.current + 0.1); }}><ZoomIn size={14} /></button>
          <button className="button button-quiet" type="button" onClick={fitPlate}><Maximize size={14} />{tr("适合窗口", "Fit plate")}</button>
          <button className="button button-quiet" type="button" onClick={() => { fitRef.current = false; changeZoom(1); }}>{tr("100% 阅读", "100% detail")}</button>
          <button className="button button-soft" type="button" onClick={toggleFullscreen}>
            {fullscreen ? <Minimize size={14} /> : <Expand size={14} />}
            {fullscreen ? tr("退出全屏", "Exit full screen") : tr("全屏查看", "Full screen")}
          </button>
        </div>
      </div>
      <div className="well-inspector">
        <span className="well-inspector-label">{tr("孔位信息", "Well details")}</span>
        <span>{inspection || tr("悬停或点选孔位，查看完整样本和基因名称。", "Hover or select a well to read the full sample and assay names.")}</span>
      </div>
      {fullscreenError && <p className="plate-view-help" role="alert">{tr("浏览器未允许全屏，请使用底部手柄调整视区高度。", "Full screen is unavailable. Use the bottom handle to resize the viewport.")}</p>}
      </div>
      <div id={viewportId} ref={viewportRef} className={`plate-scroll ${panMode ? "pan-mode" : "select-mode"}`} data-plate-zoom={zoom.toFixed(3)} style={{ height: fullscreen ? undefined : height ?? undefined }}
        onPointerDown={beginDrag} onPointerMove={updateDrag} onPointerUp={(event) => finishDrag(event)} onPointerCancel={(event) => finishDrag(event, true)}
        onPointerOver={(event) => inspectWell(event.target)} onFocusCapture={(event) => inspectWell(event.target)}
        onPointerLeave={() => { setInspectedWellId(null); if (!dragRef.current?.active) dragRef.current = null; }}
        onClickCapture={(event) => { if (suppressClickRef.current || panMode) { event.preventDefault(); event.stopPropagation(); } }}
        onDoubleClickCapture={(event) => { if (panMode) { event.preventDefault(); event.stopPropagation(); } }}
        title={tr("滚轮缩放 · 拖动框选 · ⌘/Ctrl 加选", "Wheel to zoom · Drag to select · ⌘/Ctrl to add")}>
        <div ref={gridRef} className={`plate-grid ${rows === 16 ? "plate-384" : ""} ${moveMode ? "move-mode" : ""} ${box ? "is-box-selecting" : ""}`} style={{ "--plate-columns": columns, zoom } as CSSProperties} role="grid" aria-label={tr(`${name} 孔板布局`, `${name} plate layout`)}>
          {box && <span className="well-selection-box" aria-hidden="true" style={box} />}
          {children}
        </div>
      </div>
      {!fullscreen && <div className="plate-height-handle" role="separator" tabIndex={0} aria-orientation="horizontal" aria-controls={viewportId}
        aria-label={tr("调整孔板视区高度", "Resize plate viewport height")} aria-valuemin={MIN_HEIGHT} aria-valuemax={MAX_HEIGHT} aria-valuenow={measuredHeight || undefined}
        title={tr("拖动或按上下方向键调整高度；双击或按 Enter 还原", "Drag or use arrow keys to resize; double-click or press Enter to reset")}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          resizeRef.current = { y: event.clientY, height: viewportRef.current!.getBoundingClientRect().height };
        }}
        onPointerMove={(event) => {
          if (resizeRef.current) setHeight(clampHeight(resizeRef.current.height + event.clientY - resizeRef.current.y));
        }}
        onPointerUp={(event) => {
          resizeRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => { resizeRef.current = null; }}
        onDoubleClick={() => setHeight(null)}
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End", "Enter"].includes(event.key)) return;
          event.preventDefault();
          if (event.key === "Enter") setHeight(null);
          else if (event.key === "Home") setHeight(MIN_HEIGHT);
          else if (event.key === "End") setHeight(MAX_HEIGHT);
          else setHeight(clampHeight(viewportRef.current!.getBoundingClientRect().height + (event.key === "ArrowDown" ? 40 : -40)));
        }}>
        <GripHorizontal size={18} /><span>{tr("拖动调整高度 · 双击还原", "Drag to resize · Double-click to reset")}</span>
      </div>}
      <p className="plate-view-help">{tr("滚轮缩放 · 拖动框选 · ⌘/Ctrl 加选 · 双击编辑。整板缩略图用于定位，核对文字请用 100% 阅读。", "Wheel to zoom · Drag to select · ⌘/Ctrl to add · Double-click to edit. Use Fit plate for an overview and 100% detail to read labels.")}</p>
    </div>
  );
}
