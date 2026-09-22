import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Adjusting a logo before it is saved: crop, zoom, output size, and knocking a
// background colour out to transparent.
//
// Uploading used to be the whole interaction — whatever was in the file became
// the logo, scaled to fit and nothing else. That is fine when someone has a
// square PNG on a transparent background to hand, and almost nobody does. What
// arrives is a screenshot with white around it, or a wide wordmark that has to
// sit in a square, and the only way to fix either was to open an image editor
// somewhere else and come back.
//
// The crop frame IS the viewport: what you see is exactly what gets saved.
// There is no second rectangle to line up against the picture, which is the
// part of a crop tool people get wrong.

const FRAME_W = 300;

// Output sizes offered. 240 matches what the app used to produce on its own,
// so the default changes nothing for anyone who just wants their file saved.
const SIZES = [
  { px: 128, label: "Small — 128px" },
  { px: 240, label: "Standard — 240px" },
  { px: 512, label: "Large — 512px" },
  // For the invoice logo, which is not looked at on a screen but printed. The
  // Statement of Account draws it into a 110×55pt box; at 300 DPI that box is
  // roughly 460×230 device pixels, so anything below 512 is being enlarged on
  // the page, and 1024 leaves room to spare.
  { px: 1024, label: "Print — 1024px" },
];

// What an SVG is rasterised to before anything else happens to it.
//
// Cropping and knocking a colour out both mean reading and writing pixels, so
// a vector has to become one somewhere — the question is only how big. Big
// enough that every output size below is a downscale, which is what keeps the
// result as sharp as the vector was. A browser given an SVG with no width and
// height draws it at 300×150 and the sharpness is gone before the editor ever
// sees it, so the size is set here rather than left to the default.
const SVG_RASTER_PX = 2048;

// The size the SVG is told to be, derived from its own viewBox when it does
// not say. A percentage width is not a size — it means "as wide as whatever
// you put me in" — so it is ignored rather than read as a number.
function svgAtHighResolution(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) {
    throw new Error("That file could not be read as an SVG");
  }
  const attr = (name) => {
    const raw = (svg.getAttribute(name) || "").trim();
    if (!raw || raw.endsWith("%")) return NaN;
    return parseFloat(raw);
  };
  const box = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  const hasBox = box.length === 4 && box[2] > 0 && box[3] > 0;
  let w = attr("width");
  let h = attr("height");
  if (!(w > 0) || !(h > 0)) {
    if (!hasBox) throw new Error("That SVG has no size and no viewBox, so it cannot be scaled");
    w = box[2];
    h = box[3];
  }
  if (!hasBox) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const k = SVG_RASTER_PX / Math.max(w, h);
  svg.setAttribute("width", String(Math.round(w * k)));
  svg.setAttribute("height", String(Math.round(h * k)));
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
}

const isSvg = (file) => file?.type === "image/svg+xml" || /\.svg$/i.test(file?.name || "");

const ASPECTS = [
  { value: 1, label: "Square" },
  { value: 2, label: "Wide 2:1" },
];

// Distance between two colours, 0–441. Plain Euclidean in RGB: not
// perceptually even, but the job here is "is this pixel the background",
// against a background that is usually one flat colour, and a more careful
// metric would not change which pixels go.
const distance = (r1, g1, b1, r2, g2, b2) =>
  Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);

// Takes either a freshly picked file or the data URL of a logo already saved,
// so a mark can be re-cropped later by whoever inherits it without needing the
// original file back.
export default function LogoEditor({ file, src, title = "Adjust logo", initialAspect = 1, onCancel, onApply }) {
  const [img, setImg] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [aspect, setAspect] = useState(initialAspect);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [outputPx, setOutputPx] = useState(240);
  const [knockout, setKnockout] = useState(null);
  // 15% is about right for a mark saved on a white page: it takes the
  // background and the near-white the compressor left around it, and stops
  // short of the light greys that anti-aliasing puts inside small text. At 40
  // — where this started — a wordmark's strapline came back visibly thinned,
  // because the grey along the edge of every letter reads as background.
  const [tolerance, setTolerance] = useState(15);
  const [picking, setPicking] = useState(false);
  const [outputBytes, setOutputBytes] = useState(0);

  const canvasRef = useRef(null);
  const dragRef = useRef(null);

  const frameH = Math.round(FRAME_W / aspect);

  useEffect(() => {
    const show = (dataUrl) => {
      const image = new Image();
      image.onerror = () => setLoadError("Could not read the selected image");
      image.onload = () => setImg(image);
      image.src = dataUrl;
    };
    if (!file) {
      if (src) show(src);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setLoadError("Could not read the selected file");
    if (isSvg(file)) {
      // Read as text, not as a data URL, so the size can be set on the markup
      // itself before the browser ever draws it.
      reader.onload = () => {
        try {
          show(svgAtHighResolution(String(reader.result)));
        } catch (err) {
          setLoadError(err.message);
        }
      };
      reader.readAsText(file);
      return;
    }
    reader.onload = () => show(reader.result);
    reader.readAsDataURL(file);
  }, [file, src]);

  // The source with its background knocked out, computed once per colour and
  // tolerance rather than on every pan. Kept at the image's own resolution so
  // zooming in does not reveal a knockout done at preview size.
  const source = useMemo(() => {
    if (!img) return null;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    if (!knockout) return c;

    const frame = ctx.getImageData(0, 0, c.width, c.height);
    const px = frame.data;
    const hard = (tolerance / 100) * 441;
    // A band above the threshold fades out instead of stopping dead. Without
    // it the knockout leaves a hard jagged edge around the mark, which is the
    // giveaway that a logo has been cut out badly.
    const soft = hard * 1.35;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      const d = distance(px[i], px[i + 1], px[i + 2], knockout.r, knockout.g, knockout.b);
      if (d <= hard) px[i + 3] = 0;
      else if (d < soft) px[i + 3] = Math.round(px[i + 3] * ((d - hard) / (soft - hard)));
    }
    ctx.putImageData(frame, 0, 0);
    return c;
  }, [img, knockout, tolerance]);

  // Zoom 1 fits the whole image inside the frame. A logo's own edges are part
  // of it, so the starting view shows all of it rather than filling the frame
  // and cutting the sides off; zooming past 1 is how you crop.
  const baseScale = useMemo(() => {
    if (!img) return 1;
    return Math.min(FRAME_W / img.naturalWidth, frameH / img.naturalHeight);
  }, [img, frameH]);

  // Re-centre whenever the frame shape changes: the old offset was measured
  // against a frame that no longer exists.
  useEffect(() => setOffset({ x: 0, y: 0 }), [aspect]);

  // Draws the frame exactly as it will be exported, over a checkerboard so
  // transparency is visible rather than implied.
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = FRAME_W * dpr;
    canvas.height = frameH * dpr;
    canvas.style.width = `${FRAME_W}px`;
    canvas.style.height = `${frameH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, FRAME_W, frameH);

    const square = 8;
    for (let y = 0; y < frameH; y += square) {
      for (let x = 0; x < FRAME_W; x += square) {
        ctx.fillStyle = ((x / square + y / square) % 2 === 0) ? "#f3f4f6" : "#dcdfe5";
        ctx.fillRect(x, y, square, square);
      }
    }

    const scale = baseScale * zoom;
    const w = source.width * scale;
    const h = source.height * scale;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, (FRAME_W - w) / 2 + offset.x, (frameH - h) / 2 + offset.y, w, h);
  }, [source, baseScale, zoom, offset, frameH]);

  useEffect(paint, [paint]);

  // Same geometry as the preview, at the chosen resolution. Written as one
  // function so the exported file cannot drift from what was on screen.
  const render = useCallback(
    (outW, outH) => {
      if (!source) return null;
      const out = document.createElement("canvas");
      out.width = outW;
      out.height = outH;
      const ctx = out.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      const k = outW / FRAME_W;
      const scale = baseScale * zoom * k;
      const w = source.width * scale;
      const h = source.height * scale;
      ctx.drawImage(source, (outW - w) / 2 + offset.x * k, (outH - h) / 2 + offset.y * k, w, h);
      // PNG throughout: JPEG has no alpha, and losing it would undo the one
      // thing the knockout tool is for.
      return out.toDataURL("image/png");
    },
    [source, baseScale, zoom, offset]
  );

  const outW = outputPx;
  const outH = Math.round(outputPx / aspect);

  // What the saved file will actually weigh, shown before it is saved — a
  // 512px logo is several times the size of a 240px one and it is not obvious
  // from the picker which one that is.
  useEffect(() => {
    if (!source) return;
    const url = render(outW, outH);
    setOutputBytes(url ? Math.round((url.length - url.indexOf(",") - 1) * 0.75) : 0);
  }, [source, render, outW, outH]);

  const onPointerDown = (e) => {
    if (picking) {
      pickColourAt(e);
      return;
    }
    const rect = canvasRef.current.getBoundingClientRect();
    dragRef.current = { x: e.clientX - rect.left - offset.x, y: e.clientY - rect.top - offset.y };
    canvasRef.current.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!dragRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    setOffset({ x: e.clientX - rect.left - dragRef.current.x, y: e.clientY - rect.top - dragRef.current.y });
  };

  const onPointerUp = (e) => {
    dragRef.current = null;
    try {
      canvasRef.current.releasePointerCapture(e.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
  };

  // Reads the colour under the click from the *original* image rather than the
  // preview, so picking twice does not sample a pixel the first knockout has
  // already made transparent.
  const pickColourAt = (e) => {
    if (!img) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scale = baseScale * zoom;
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    const ix = Math.round((x - ((FRAME_W - w) / 2 + offset.x)) / scale);
    const iy = Math.round((y - ((frameH - h) / 2 + offset.y)) / scale);
    if (ix < 0 || iy < 0 || ix >= img.naturalWidth || iy >= img.naturalHeight) {
      setPicking(false);
      return;
    }
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const [r, g, b] = ctx.getImageData(ix, iy, 1, 1).data;
    setKnockout({ r, g, b });
    setPicking(false);
  };

  const reset = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setKnockout(null);
    setPicking(false);
  };

  const apply = () => {
    const url = render(outW, outH);
    if (url) onApply(url);
  };

  const kb = outputBytes >= 1024 ? `${Math.round(outputBytes / 1024)} KB` : `${outputBytes} B`;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 380 }}>
        <h2>{title}</h2>
        <p className="subtitle" style={{ marginTop: -8 }}>
          Drag to move, zoom to crop. What is inside the frame is what gets saved.
        </p>

        {loadError && <div className="error-banner">{loadError}</div>}

        <div style={{ display: "flex", justifyContent: "center", margin: "6px 0 14px" }}>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              cursor: picking ? "crosshair" : "grab",
              touchAction: "none",
            }}
          />
        </div>

        <div className="form-row">
          <label>Shape</label>
          <div style={{ display: "flex", gap: 8 }}>
            {ASPECTS.map((a) => (
              <button
                key={a.value}
                type="button"
                className={`btn btn-sm ${aspect === a.value ? "" : "btn-secondary"}`}
                onClick={() => setAspect(a.value)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>

        <div className="form-row">
          <label>Zoom — {zoom.toFixed(2)}×</label>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              aria-label="Zoom out"
              onClick={() => setZoom((z) => Math.max(0.2, Math.round((z - 0.1) * 100) / 100))}
            >
              −
            </button>
            <input
              type="range"
              min="0.2"
              max="4"
              step="0.01"
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              aria-label="Zoom in"
              onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.1) * 100) / 100))}
            >
              +
            </button>
          </div>
        </div>

        <div className="form-row">
          <label>Transparent background</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className={`btn btn-sm ${picking ? "" : "btn-secondary"}`}
              onClick={() => setPicking((v) => !v)}
            >
              {picking ? "Click the colour…" : "Pick a colour"}
            </button>
            {/* The overwhelmingly common case — a mark saved on a white page —
                without asking anyone to aim at a pixel for it. */}
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                setKnockout({ r: 255, g: 255, b: 255 });
                setPicking(false);
              }}
            >
              Remove white
            </button>
            {knockout && (
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => setKnockout(null)}>
                Keep background
              </button>
            )}
          </div>
          {knockout && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 3,
                  border: "1px solid var(--border)",
                  background: `rgb(${knockout.r}, ${knockout.g}, ${knockout.b})`,
                  flexShrink: 0,
                }}
              />
              <input
                type="range"
                min="0"
                max="100"
                value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value))}
                style={{ flex: 1 }}
                aria-label="How close a colour must be to be removed"
              />
              <span className="subtitle" style={{ margin: 0, fontSize: 12, minWidth: 74 }}>
                {tolerance}% spread
              </span>
            </div>
          )}
        </div>

        <div className="form-row">
          <label>Saved size</label>
          <select value={outputPx} onChange={(e) => setOutputPx(Number(e.target.value))}>
            {SIZES.map((s) => (
              <option key={s.px} value={s.px}>{s.label}</option>
            ))}
          </select>
          <span className="subtitle" style={{ fontSize: 12, display: "block" }}>
            {outW}×{outH}px, about {kb} once saved.
          </span>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={reset}>Reset</button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn" disabled={!source} onClick={apply}>Save logo</button>
        </div>
      </div>
    </div>
  );
}
