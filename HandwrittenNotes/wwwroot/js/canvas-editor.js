(function () {
    'use strict';

    const canvas = document.getElementById('mainCanvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const pageId   = canvas.dataset.pageId;
    const canvasW  = parseInt(canvas.dataset.width)  || 1920;
    const canvasH  = parseInt(canvas.dataset.height) || 1080;
    canvas.width   = canvasW;
    canvas.height  = canvasH;

    // ── State ─────────────────────────────────────────────────────────────────
    let tool          = 'pen';
    let brushSize     = 2;
    let fgColor       = '#000000';
    let bgColor       = '#ffffff';
    let isDrawing        = false;
    let drawingPointerId = -1;
    let startX = 0, startY = 0, lastX = 0, lastY = 0;
    let shapeSnap     = null;
    let sprayTimer    = null;
    let isDirty       = false;

    // Off-screen canvas used by the smear tool for alpha-correct blending
    const smearCanvas = document.createElement('canvas');
    smearCanvas.width  = canvasW;
    smearCanvas.height = canvasH;
    const smearCtx = smearCanvas.getContext('2d');

    // Lines overlay for lined page styles
    const pageStyle  = canvas.dataset.style || '';
    const isLined    = pageStyle.startsWith('lined-');
    const linesEl    = document.getElementById('linesCanvas');
    let linesVisible = isLined;

    // viewport pan/zoom
    let scale = 1, panX = 0, panY = 0;
    let isPanning = false;
    let panOriginX = 0, panOriginY = 0, panOriginPX = 0, panOriginPY = 0;

    // multitouch
    const pointers    = new Map();
    let lastPinchDist = 0;
    let lastCentroid  = null;

    // ── Undo history ──────────────────────────────────────────────────────────
    // Snapshots are stored as off-screen canvas elements copied with drawImage.
    // This is ~100x faster than canvas.toDataURL (no PNG encoding on the main
    // thread), eliminating the blocking that caused quick successive strokes to
    // drop: toDataURL could take 50-500 ms, during which a fast pointerup would
    // queue and immediately terminate the stroke after isDrawing was set true.
    const MAX_HISTORY = 20;
    const history     = [];  // array of HTMLCanvasElement snapshots

    function pushHistory() {
        const snap = document.createElement('canvas');
        snap.width  = canvasW;
        snap.height = canvasH;
        snap.getContext('2d').drawImage(canvas, 0, 0);
        history.push(snap);
        if (history.length > MAX_HISTORY) history.shift();
        updateUndoBtn();
    }

    function updateUndoBtn() {
        const btn = document.getElementById('undoBtn');
        if (btn) btn.disabled = history.length === 0;
    }

    function undo() {
        if (history.length === 0) return;
        const snap = history.pop();
        ctx.clearRect(0, 0, canvasW, canvasH);
        ctx.drawImage(snap, 0, 0);
        markDirty();
        updateUndoBtn();
    }

    // MS-Paint 16-colour palette
    const PALETTE = [
        '#000000','#ffffff','#808080','#c0c0c0',
        '#800000','#ff0000','#808000','#ffff00',
        '#008000','#00ff00','#008080','#00ffff',
        '#000080','#0000ff','#800080','#ff00ff'
    ];

    // ── Viewport ──────────────────────────────────────────────────────────────
    const viewport    = document.getElementById('canvasViewport');
    const canvasInner = document.getElementById('canvasInner');

    function applyTransform() {
        if (canvasInner) canvasInner.style.transform = `translate(${panX}px,${panY}px) scale(${scale})`;
    }

    function fitToScreen() {
        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        scale = Math.min(vw / canvasW, vh / canvasH) * 0.92;
        panX  = 0; panY = 0;
        applyTransform();
    }

    document.getElementById('zoomFitBtn')?.addEventListener('click', fitToScreen);

    viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        scale = Math.max(0.05, Math.min(20, scale * (e.deltaY > 0 ? 0.9 : 1.1)));
        applyTransform();
    }, { passive: false });

    // ── Canvas coordinate mapping ─────────────────────────────────────────────
    function canvasXY(e) {
        const r = canvas.getBoundingClientRect();
        return {
            x: (e.clientX - r.left) * (canvasW / r.width),
            y: (e.clientY - r.top)  * (canvasH / r.height)
        };
    }

    // ── Colour palette ────────────────────────────────────────────────────────
    function buildPalette() {
        const el = document.getElementById('colorSwatches');
        if (!el) return;
        PALETTE.forEach(c => {
            const sw = document.createElement('div');
            sw.className = 'color-swatch';
            sw.style.background = c;
            sw.title = c;
            sw.addEventListener('click',       () => setFg(c));
            sw.addEventListener('contextmenu', (e) => { e.preventDefault(); setBg(c); });
            el.appendChild(sw);
        });
        refreshSwatches();
    }

    function setFg(c) { fgColor = c; refreshSwatches(); }
    function setBg(c) { bgColor = c; refreshSwatches(); }

    function refreshSwatches() {
        const fg = document.getElementById('swatchFg');
        const bg = document.getElementById('swatchBg');
        if (fg) fg.style.background = fgColor;
        if (bg) bg.style.background = bgColor;
    }

    const customBtn   = document.getElementById('customColorBtn');
    const colorPicker = document.getElementById('customColorPicker');
    if (customBtn && colorPicker) {
        customBtn.addEventListener('click', () => { colorPicker.value = fgColor; colorPicker.click(); });
        colorPicker.addEventListener('input', () => setFg(colorPicker.value));
    }

    // ── Tool / size selectors ─────────────────────────────────────────────────
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            stopSpray();
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            tool = btn.dataset.tool;
        });
    });

    document.querySelectorAll('.group-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const name  = btn.dataset.group;
            const panel = document.getElementById('panel' + name.charAt(0).toUpperCase() + name.slice(1));
            const wasOpen = panel && !panel.classList.contains('hidden');
            document.querySelectorAll('.group-panel').forEach(p => p.classList.add('hidden'));
            document.querySelectorAll('.group-toggle').forEach(b => b.classList.remove('open'));
            if (panel && !wasOpen) { panel.classList.remove('hidden'); btn.classList.add('open'); }
        });
    });

    document.addEventListener('click', () => {
        document.querySelectorAll('.group-panel').forEach(p => p.classList.add('hidden'));
        document.querySelectorAll('.group-toggle').forEach(b => b.classList.remove('open'));
    });

    document.querySelectorAll('.size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            brushSize = parseInt(btn.dataset.size);
        });
    });

    // ── Drawing context helpers ───────────────────────────────────────────────
    function applyDrawStyle(pressure) {
        ctx.lineWidth   = brushSize;
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
        ctx.strokeStyle = (tool === 'eraser') ? bgColor : fgColor;
        ctx.fillStyle   = fgColor;
        ctx.globalAlpha = (tool === 'pen') ? Math.max(0.15, pressure) : 1;
        ctx.globalCompositeOperation = 'source-over';
    }

    function resetCtxState() {
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
    }

    // ── Pointer events ────────────────────────────────────────────────────────
    // Listen on the viewport so pinch gestures anywhere in the dark surround
    // are handled by the app rather than passed to the browser as page zoom.
    viewport.addEventListener('pointerdown',   onDown);
    viewport.addEventListener('pointermove',   onMove);
    viewport.addEventListener('pointerup',     onUp);
    viewport.addEventListener('pointercancel', onUp);
    viewport.addEventListener('contextmenu',   e => e.preventDefault());



    function onDown(e) {
        // No e.preventDefault() — touch-action:none in CSS handles scroll/zoom.
        // Calling preventDefault() on pointerdown causes iOS to stop dispatching
        // events after ~5 rapid strokes (gesture-engine rate-limit on consumed inputs).
        viewport.setPointerCapture(e.pointerId);

        if (e.pointerType === 'touch') {
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size >= 2) {
                // Second finger down — cancel any active stroke and pinch instead.
                isDrawing = false; drawingPointerId = -1;
                stopSpray(); initPinch(); return;
            }
            // Single finger: allow drawing unless something else is already drawing.
            if (isDrawing) return;
        } else {
            // Pen / mouse ─────────────────────────────────────────────────────
            if (e.button === 1 || e.button === 2) {
                isPanning = true;
                panOriginX = e.clientX; panOriginY = e.clientY;
                panOriginPX = panX;     panOriginPY = panY;
                return;
            }
            // If a previous stroke's pointerup hasn't arrived yet (quick successive
            // strokes), cleanly terminate it before starting the next one so the
            // late pointerup can't cancel the new stroke.
            if (isDrawing) { stopSpray(); isDrawing = false; shapeSnap = null; }
        }

        const pos = canvasXY(e);
        if (pos.x < 0 || pos.x >= canvasW || pos.y < 0 || pos.y >= canvasH) return;

        startX = pos.x; startY = pos.y;
        lastX  = pos.x; lastY  = pos.y;
        drawingPointerId = e.pointerId;

        pushHistory();
        isDrawing = true;
        markDirty();

        if (['line','rect','filledRect','ellipse','filledEllipse'].includes(tool)) {
            shapeSnap = ctx.getImageData(0, 0, canvasW, canvasH); return;
        }

        if (tool === 'floodFill') { floodFill(Math.round(pos.x), Math.round(pos.y)); isDrawing = false; drawingPointerId = -1; return; }
        if (tool === 'spray')   { startSpray(pos.x, pos.y); return; }
        if (tool === 'smear')   { return; }
        if (tool === 'lighten') { applyLighten(pos.x, pos.y); return; }

        applyDrawStyle(e.pressure || 0.5);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, brushSize / 2, 0, Math.PI * 2);
        ctx.fillStyle = (tool === 'eraser') ? bgColor : fgColor;
        ctx.fill();
        resetCtxState();
    }

    function onMove(e) {
        // touch-action:none in CSS handles scroll/zoom prevention — no preventDefault needed

        if (e.pointerType === 'touch') {
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size >= 2) { handlePinch(); return; }
            // Single-finger touch: only draw if this is the pointer that started the stroke.
            if (e.pointerId !== drawingPointerId) return;
        } else {
            // Pen / mouse ─────────────────────────────────────────────────────
            if (isPanning) {
                panX = panOriginPX + (e.clientX - panOriginX);
                panY = panOriginPY + (e.clientY - panOriginY);
                applyTransform(); return;
            }
            if (e.pointerId !== drawingPointerId) return;
        }

        if (!isDrawing) return;

        const pos = canvasXY(e);

        if (tool === 'spray') {
            stopSpray(); startSpray(pos.x, pos.y);
        } else if (tool === 'smear') {
            applySmear(lastX, lastY, pos.x, pos.y);
        } else if (tool === 'lighten') {
            applyLighten(pos.x, pos.y);
        } else if (tool === 'pen' || tool === 'eraser') {
            applyDrawStyle(e.pressure || 0.5);
            ctx.beginPath();
            ctx.moveTo(lastX, lastY);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
            resetCtxState();
        } else if (shapeSnap) {
            ctx.putImageData(shapeSnap, 0, 0);
            applyDrawStyle(1);
            drawShape(startX, startY, pos.x, pos.y);
            resetCtxState();
        }

        lastX = pos.x; lastY = pos.y;
    }

    function onUp(e) {
        if (e.pointerType === 'touch') {
            pointers.delete(e.pointerId);
            lastPinchDist = 0; lastCentroid = null;
            // Only end the stroke if this was the drawing finger.
            if (e.pointerId !== drawingPointerId) return;
        } else {
            // Pen / mouse ─────────────────────────────────────────────────────
            if (isPanning) { isPanning = false; return; }
            // Ignore a late pointerup that belongs to a previous stroke.
            if (e.pointerId !== drawingPointerId) return;
        }

        drawingPointerId = -1;
        if (!isDrawing) return;

        const pos = canvasXY(e);

        if (shapeSnap) {
            ctx.putImageData(shapeSnap, 0, 0);
            applyDrawStyle(1);
            drawShape(startX, startY, pos.x, pos.y);
            resetCtxState();
            shapeSnap = null;
        }

        stopSpray();
        isDrawing = false;
    }

    function drawShape(x1, y1, x2, y2) {
        ctx.beginPath();
        switch (tool) {
            case 'line':         ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); break;
            case 'rect':         ctx.strokeRect(x1,y1,x2-x1,y2-y1); break;
            case 'filledRect':   ctx.fillStyle=fgColor; ctx.fillRect(x1,y1,x2-x1,y2-y1); break;
            case 'ellipse':      ctx.ellipse((x1+x2)/2,(y1+y2)/2,Math.abs(x2-x1)/2,Math.abs(y2-y1)/2,0,0,Math.PI*2); ctx.stroke(); break;
            case 'filledEllipse':ctx.fillStyle=fgColor; ctx.ellipse((x1+x2)/2,(y1+y2)/2,Math.abs(x2-x1)/2,Math.abs(y2-y1)/2,0,0,Math.PI*2); ctx.fill(); break;
        }
    }

    // ── Pinch zoom ────────────────────────────────────────────────────────────
    function initPinch() {
        const pts = [...pointers.values()];
        if (pts.length < 2) return;
        lastPinchDist = Math.hypot(pts[1].x-pts[0].x, pts[1].y-pts[0].y);
        lastCentroid  = { x:(pts[0].x+pts[1].x)/2, y:(pts[0].y+pts[1].y)/2 };
    }

    function handlePinch() {
        const pts = [...pointers.values()];
        if (pts.length < 2) return;
        const dist     = Math.hypot(pts[1].x-pts[0].x, pts[1].y-pts[0].y);
        const centroid = { x:(pts[0].x+pts[1].x)/2, y:(pts[0].y+pts[1].y)/2 };
        if (lastPinchDist > 0) { scale = Math.max(0.05,Math.min(20,scale*(dist/lastPinchDist))); applyTransform(); }
        if (lastCentroid)      { panX += centroid.x-lastCentroid.x; panY += centroid.y-lastCentroid.y; applyTransform(); }
        lastPinchDist = dist; lastCentroid = centroid;
    }

    // ── Spray ─────────────────────────────────────────────────────────────────
    const SPRAY_R = 20, SPRAY_N = 15;

    function startSpray(x, y) {
        sprayTimer = setInterval(() => {
            ctx.fillStyle = fgColor; ctx.globalAlpha = 0.8;
            for (let i = 0; i < SPRAY_N; i++) {
                const a = Math.random()*Math.PI*2, r = Math.random()*SPRAY_R;
                ctx.fillRect(x+Math.cos(a)*r, y+Math.sin(a)*r, brushSize, brushSize);
            }
            ctx.globalAlpha = 1;
        }, 16);
    }

    function stopSpray() {
        if (sprayTimer) { clearInterval(sprayTimer); sprayTimer = null; }
    }

    // ── Smear ─────────────────────────────────────────────────────────────────
    // Samples a circular region around the previous pointer position and
    // composites it at the new position, dragging pixels forward.
    function applySmear(fromX, fromY, toX, toY) {
        const r  = Math.max(brushSize * 4, 10);
        const sx = Math.max(0, Math.round(fromX - r));
        const sy = Math.max(0, Math.round(fromY - r));
        const sw = Math.min(canvasW - sx, r * 2);
        const sh = Math.min(canvasH - sy, r * 2);
        if (sw <= 0 || sh <= 0) return;

        // Copy source region to the off-screen canvas
        smearCtx.putImageData(ctx.getImageData(sx, sy, sw, sh), 0, 0);

        // Composite it at the destination with partial opacity, clipped to a circle.
        // putImageData ignores globalAlpha so we route through drawImage.
        const dx = Math.round(toX - r);
        const dy = Math.round(toY - r);
        ctx.save();
        ctx.beginPath();
        ctx.arc(toX, toY, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.globalAlpha = 0.72;
        ctx.drawImage(smearCanvas, 0, 0, sw, sh, dx, dy, sw, sh);
        ctx.restore();
    }

    // ── Lighten (partial erase) ───────────────────────────────────────────────
    // Soft circular brush that nudges each pixel toward white by a fixed
    // fraction per pass, with a radial falloff toward the brush edge.
    function applyLighten(x, y) {
        const r  = Math.max(brushSize * 4, 10);
        const x0 = Math.max(0, Math.round(x - r));
        const y0 = Math.max(0, Math.round(y - r));
        const x1 = Math.min(canvasW, Math.round(x + r));
        const y1 = Math.min(canvasH, Math.round(y + r));
        const w  = x1 - x0, h = y1 - y0;
        if (w <= 0 || h <= 0) return;

        const imgData = ctx.getImageData(x0, y0, w, h);
        const d = imgData.data;
        const cx = x - x0, cy = y - y0;

        for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
                const dist = Math.hypot(px - cx, py - cy);
                if (dist >= r) continue;
                const falloff  = 1 - dist / r;       // full effect at centre
                const strength = 0.22 * falloff;      // gentle per-pass nudge
                const i = (py * w + px) * 4;
                d[i]   = d[i]   + (255 - d[i])   * strength;
                d[i+1] = d[i+1] + (255 - d[i+1]) * strength;
                d[i+2] = d[i+2] + (255 - d[i+2]) * strength;
            }
        }
        ctx.putImageData(imgData, x0, y0);
    }

    // ── Lines drawing ─────────────────────────────────────────────────────────
    // Mirrors BmpUtils.GenerateLined in C# but renders directly to linesEl.
    // Drawing happens in JS so lines appear instantly without a server round-trip.
    function drawLines() {
        if (!linesEl) return;
        const spacing = pageStyle === 'lined-college' ? 56 : pageStyle === 'lined-narrow' ? 50 : 69;
        const lctx = linesEl.getContext('2d');
        lctx.fillStyle = '#ffffff';
        lctx.fillRect(0, 0, canvasW, canvasH);
        lctx.lineWidth = 1;
        lctx.strokeStyle = '#B0C4DE';
        for (let y = 200; y < canvasH; y += spacing) {
            lctx.beginPath();
            lctx.moveTo(0, y + 0.5);
            lctx.lineTo(canvasW, y + 0.5);
            lctx.stroke();
        }
        lctx.strokeStyle = '#FF9999';
        lctx.beginPath();
        lctx.moveTo(200.5, 0);
        lctx.lineTo(200.5, canvasH);
        lctx.stroke();
    }

    // ── Flood fill ────────────────────────────────────────────────────────────
    function hexToRgb(hex) {
        const n = parseInt(hex.replace('#',''), 16);
        return [(n>>16)&255, (n>>8)&255, n&255];
    }

    function floodFill(sx, sy) {
        if (sx < 0 || sx >= canvasW || sy < 0 || sy >= canvasH) return;
        const imgData = ctx.getImageData(0, 0, canvasW, canvasH);
        const d = imgData.data;
        const [fr, fg2, fb] = hexToRgb(fgColor);
        const base = (sy*canvasW+sx)*4;
        const tr=d[base], tg=d[base+1], tb=d[base+2], ta=d[base+3];
        if (tr===fr && tg===fg2 && tb===fb && ta===255) return;
        const visited = new Uint8Array(canvasW*canvasH);
        const stack   = [sy*canvasW+sx];
        while (stack.length) {
            const pos = stack.pop();
            if (visited[pos]) continue;
            visited[pos] = 1;
            const i = pos*4;
            if (d[i]!==tr||d[i+1]!==tg||d[i+2]!==tb||d[i+3]!==ta) continue;
            d[i]=fr; d[i+1]=fg2; d[i+2]=fb; d[i+3]=255;
            const x=pos%canvasW, y=(pos/canvasW)|0;
            if (x>0)           stack.push(pos-1);
            if (x<canvasW-1)   stack.push(pos+1);
            if (y>0)           stack.push(pos-canvasW);
            if (y<canvasH-1)   stack.push(pos+canvasW);
        }
        ctx.putImageData(imgData, 0, 0);
    }

    // ── Dirty tracking & save ─────────────────────────────────────────────────
    const indicator = document.getElementById('canvasSaveIndicator');

    function markDirty() {
        isDirty = true;
        if (indicator) { indicator.textContent = 'Unsaved'; indicator.className = 'save-indicator saving'; }
    }

    function setIndicator(cls, text) {
        if (!indicator) return;
        indicator.textContent = text;
        indicator.className   = 'save-indicator ' + cls;
        setTimeout(() => { if (indicator) { indicator.textContent=''; indicator.className='save-indicator'; } }, 2000);
    }

    async function saveCanvas() {
        if (!isDirty) return;
        setIndicator('saving', 'Saving…');
        try {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const resp = await fetch(`/api/pages/${pageId}/content?type=bmp`, {
                method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob
            });
            if (resp.ok) { isDirty = false; setIndicator('saved', 'Saved'); }
            else           setIndicator('error', 'Error');
        } catch { setIndicator('error', 'Error'); }
    }

    // ── Autosave every 30 s ───────────────────────────────────────────────────
    setInterval(() => { if (isDirty) saveCanvas(); }, 30000);

    // ── Keyboard shortcuts ────────────────────────────────────────────────────
    document.getElementById('saveCanvasBtn')?.addEventListener('click', saveCanvas);
    document.getElementById('undoBtn')?.addEventListener('click', undo);

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey||e.metaKey) && e.key === 's') { e.preventDefault(); saveCanvas(); }
        if ((e.ctrlKey||e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    });

    window.addEventListener('beforeunload', (e) => { if (isDirty) e.preventDefault(); });

    // ── Boot ──────────────────────────────────────────────────────────────────
    buildPalette();
    document.querySelectorAll('.group-panel').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.group-toggle').forEach(b => { b.classList.remove('active','open'); });

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Set up lines overlay for lined page styles
    if (isLined && linesEl) {
        linesEl.width  = canvasW;
        linesEl.height = canvasH;
        drawLines();
        canvas.style.mixBlendMode = 'multiply';
    } else if (linesEl) {
        linesEl.style.display = 'none';
    }

    // Lines toggle button
    document.getElementById('toggleLinesBtn')?.addEventListener('click', () => {
        linesVisible = !linesVisible;
        if (linesEl) linesEl.style.display = linesVisible ? '' : 'none';
        canvas.style.mixBlendMode = linesVisible ? 'multiply' : '';
        const btn = document.getElementById('toggleLinesBtn');
        if (btn) btn.textContent = linesVisible ? 'Hide Lines' : 'Show Lines';
    });

    // Load any previously saved ink (404 is fine for brand-new lined pages)
    const loadingOverlay = document.getElementById('canvasLoadingOverlay');
    const srcImg = new Image();
    srcImg.onload = () => {
        ctx.drawImage(srcImg, 0, 0);
        loadingOverlay?.classList.add('hidden');
    };
    srcImg.onerror = () => { loadingOverlay?.classList.add('hidden'); };
    srcImg.src = `/api/pages/${pageId}/content?type=bmp&t=${Date.now()}`;

    fitToScreen();
    updateUndoBtn();

    // ── Browser-zoom reset button ─────────────────────────────────────────────
    // Appears in the right gutter when iOS Safari zooms the page (scale > 1).
    // Tapping it resets the viewport meta to snap the browser back to 1:1.
    const zoomResetBtn = document.getElementById('zoomResetBtn');
    if (zoomResetBtn && window.visualViewport) {
        const onViewportChange = () => {
            const zoomed = window.visualViewport.scale > 1.05;
            zoomResetBtn.style.display = zoomed ? 'block' : 'none';
        };
        window.visualViewport.addEventListener('resize', onViewportChange);
        window.visualViewport.addEventListener('scroll', onViewportChange);

        zoomResetBtn.addEventListener('pointerdown', e => {
            e.stopPropagation();
            const meta = document.querySelector('meta[name=viewport]');
            meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
            zoomResetBtn.style.display = 'none';
        });
    }
})();
