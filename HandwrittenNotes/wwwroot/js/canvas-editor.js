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
    let isDrawing     = false;
    let startX = 0, startY = 0, lastX = 0, lastY = 0;
    let shapeSnap     = null;   // saved ImageData for shape preview
    let sprayTimer    = null;
    let isDirty       = false;

    // viewport pan/zoom
    let scale = 1, panX = 0, panY = 0;
    let isPanning = false;
    let panOriginX = 0, panOriginY = 0, panOriginPX = 0, panOriginPY = 0;

    // multitouch
    const pointers    = new Map();
    let lastPinchDist = 0;
    let lastCentroid  = null;

    // MS-Paint 16-colour palette
    const PALETTE = [
        '#000000','#ffffff','#808080','#c0c0c0',
        '#800000','#ff0000','#808000','#ffff00',
        '#008000','#00ff00','#008080','#00ffff',
        '#000080','#0000ff','#800080','#ff00ff'
    ];

    // ── Viewport ──────────────────────────────────────────────────────────────
    const viewport = document.getElementById('canvasViewport');

    function applyTransform() {
        canvas.style.transform = `translate(${panX}px,${panY}px) scale(${scale})`;
    }

    function fitToScreen() {
        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        scale = Math.min(vw / canvasW, vh / canvasH) * 0.92;
        panX  = 0;
        panY  = 0;
        applyTransform();
    }

    document.getElementById('zoomFitBtn')?.addEventListener('click', fitToScreen);

    viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        scale = Math.max(0.05, Math.min(20, scale * factor));
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

    // Custom-colour picker
    const customBtn    = document.getElementById('customColorBtn');
    const colorPicker  = document.getElementById('customColorPicker');
    if (customBtn && colorPicker) {
        customBtn.addEventListener('click', () => {
            colorPicker.value = fgColor;
            colorPicker.click();
        });
        colorPicker.addEventListener('input', () => setFg(colorPicker.value));
    }

    // ── Tool/size selectors ───────────────────────────────────────────────────
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            stopSpray();
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            tool = btn.dataset.tool;
        });
    });

    // Group dropdowns – close all then toggle clicked
    document.querySelectorAll('.group-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const name  = btn.dataset.group;
            const panel = document.getElementById('panel' + name.charAt(0).toUpperCase() + name.slice(1));
            const wasOpen = panel && !panel.classList.contains('hidden');

            document.querySelectorAll('.group-panel').forEach(p => p.classList.add('hidden'));
            document.querySelectorAll('.group-toggle').forEach(b => b.classList.remove('open'));

            if (panel && !wasOpen) {
                panel.classList.remove('hidden');
                btn.classList.add('open');
            }
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
    canvas.addEventListener('pointerdown',  onDown);
    canvas.addEventListener('pointermove',  onMove);
    canvas.addEventListener('pointerup',    onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('contextmenu',  e => e.preventDefault());

    function onDown(e) {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size >= 2) {
            // entering multitouch — cancel any freehand
            isDrawing = false;
            stopSpray();
            initPinch();
            return;
        }

        // Right/middle button → pan
        if (e.button === 1 || e.button === 2) {
            isPanning    = true;
            panOriginX   = e.clientX; panOriginY  = e.clientY;
            panOriginPX  = panX;      panOriginPY = panY;
            return;
        }

        const pos = canvasXY(e);
        startX = pos.x; startY = pos.y;
        lastX  = pos.x; lastY  = pos.y;
        isDrawing = true;
        markDirty();

        if (['line','rect','filledRect','ellipse','filledEllipse'].includes(tool)) {
            shapeSnap = ctx.getImageData(0, 0, canvasW, canvasH);
            return;
        }

        if (tool === 'floodFill') {
            floodFill(Math.round(pos.x), Math.round(pos.y));
            isDrawing = false;
            return;
        }

        if (tool === 'spray') {
            startSpray(pos.x, pos.y);
            return;
        }

        // pen / eraser — draw initial dot
        applyDrawStyle(e.pressure || 0.5);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, brushSize / 2, 0, Math.PI * 2);
        ctx.fillStyle = (tool === 'eraser') ? bgColor : fgColor;
        ctx.fill();
        resetCtxState();
    }

    function onMove(e) {
        e.preventDefault();
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        // Multitouch: pinch-zoom + pan
        if (pointers.size >= 2) {
            handlePinch();
            return;
        }

        if (isPanning) {
            panX = panOriginPX + (e.clientX - panOriginX);
            panY = panOriginPY + (e.clientY - panOriginY);
            applyTransform();
            return;
        }

        if (!isDrawing) return;

        const pos = canvasXY(e);

        if (tool === 'spray') {
            stopSpray();
            startSpray(pos.x, pos.y);
        } else if (tool === 'pen' || tool === 'eraser') {
            applyDrawStyle(e.pressure || 0.5);
            ctx.beginPath();
            ctx.moveTo(lastX, lastY);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
            // start next segment from current point
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
        pointers.delete(e.pointerId);
        lastPinchDist = 0;
        lastCentroid  = null;

        if (isPanning) { isPanning = false; return; }
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
            case 'line':
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
                break;
            case 'rect':
                ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
                break;
            case 'filledRect':
                ctx.fillStyle = fgColor;
                ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
                break;
            case 'ellipse':
                ctx.ellipse((x1+x2)/2, (y1+y2)/2, Math.abs(x2-x1)/2, Math.abs(y2-y1)/2, 0, 0, Math.PI*2);
                ctx.stroke();
                break;
            case 'filledEllipse':
                ctx.fillStyle = fgColor;
                ctx.ellipse((x1+x2)/2, (y1+y2)/2, Math.abs(x2-x1)/2, Math.abs(y2-y1)/2, 0, 0, Math.PI*2);
                ctx.fill();
                break;
        }
    }

    // ── Pinch zoom ────────────────────────────────────────────────────────────
    function initPinch() {
        const pts = [...pointers.values()];
        if (pts.length < 2) return;
        lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        lastCentroid  = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    }

    function handlePinch() {
        const pts = [...pointers.values()];
        if (pts.length < 2) return;

        const dist     = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const centroid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };

        if (lastPinchDist > 0) {
            scale = Math.max(0.05, Math.min(20, scale * (dist / lastPinchDist)));
            applyTransform();
        }

        if (lastCentroid) {
            panX += centroid.x - lastCentroid.x;
            panY += centroid.y - lastCentroid.y;
            applyTransform();
        }

        lastPinchDist = dist;
        lastCentroid  = centroid;
    }

    // ── Spray ─────────────────────────────────────────────────────────────────
    const SPRAY_R = 20, SPRAY_N = 15;

    function startSpray(x, y) {
        sprayTimer = setInterval(() => {
            ctx.fillStyle   = fgColor;
            ctx.globalAlpha = 0.8;
            for (let i = 0; i < SPRAY_N; i++) {
                const a = Math.random() * Math.PI * 2;
                const r = Math.random() * SPRAY_R;
                ctx.fillRect(x + Math.cos(a) * r, y + Math.sin(a) * r, brushSize, brushSize);
            }
            ctx.globalAlpha = 1;
        }, 16);
    }

    function stopSpray() {
        if (sprayTimer) { clearInterval(sprayTimer); sprayTimer = null; }
    }

    // ── Flood fill ────────────────────────────────────────────────────────────
    function hexToRgb(hex) {
        const n = parseInt(hex.replace('#',''), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function floodFill(sx, sy) {
        if (sx < 0 || sx >= canvasW || sy < 0 || sy >= canvasH) return;

        const imgData = ctx.getImageData(0, 0, canvasW, canvasH);
        const d = imgData.data;
        const [fr, fg2, fb] = hexToRgb(fgColor);

        const base = (sy * canvasW + sx) * 4;
        const tr = d[base], tg = d[base+1], tb = d[base+2], ta = d[base+3];

        // Already that colour
        if (tr === fr && tg === fg2 && tb === fb && ta === 255) return;

        const visited = new Uint8Array(canvasW * canvasH);
        const stack   = [sy * canvasW + sx];

        while (stack.length) {
            const pos = stack.pop();
            if (visited[pos]) continue;
            visited[pos] = 1;

            const i = pos * 4;
            if (d[i] !== tr || d[i+1] !== tg || d[i+2] !== tb || d[i+3] !== ta) continue;

            d[i] = fr; d[i+1] = fg2; d[i+2] = fb; d[i+3] = 255;

            const x = pos % canvasW;
            const y = (pos / canvasW) | 0;
            if (x > 0)           stack.push(pos - 1);
            if (x < canvasW - 1) stack.push(pos + 1);
            if (y > 0)           stack.push(pos - canvasW);
            if (y < canvasH - 1) stack.push(pos + canvasW);
        }

        ctx.putImageData(imgData, 0, 0);
    }

    // ── Dirty tracking & save ─────────────────────────────────────────────────
    const indicator = document.getElementById('canvasSaveIndicator');

    function markDirty() {
        if (isDirty) return;
        isDirty = true;
        if (indicator) { indicator.textContent = 'Unsaved'; indicator.className = 'save-indicator saving'; }
    }

    function setIndicator(cls, text) {
        if (!indicator) return;
        indicator.textContent = text;
        indicator.className   = 'save-indicator ' + cls;
        setTimeout(() => {
            if (indicator) { indicator.textContent = ''; indicator.className = 'save-indicator'; }
        }, 2000);
    }

    async function saveCanvas() {
        if (!isDirty) return;
        setIndicator('saving', 'Saving…');
        try {
            const bytes = canvasToBmp(canvas);
            const resp  = await fetch(`/api/pages/${pageId}/content?type=bmp`, {
                method:  'PUT',
                headers: { 'Content-Type': 'image/bmp' },
                body:    bytes
            });
            if (resp.ok) { isDirty = false; setIndicator('saved', 'Saved'); }
            else           setIndicator('error', 'Error');
        } catch {
            setIndicator('error', 'Error');
        }
    }

    document.getElementById('saveCanvasBtn')?.addEventListener('click', saveCanvas);
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCanvas(); }
    });
    window.addEventListener('beforeunload', (e) => { if (isDirty) e.preventDefault(); });

    // ── BMP encoder (24-bit uncompressed, top-down) ───────────────────────────
    function canvasToBmp(c) {
        const w  = c.width, h = c.height;
        const px = c.getContext('2d').getImageData(0, 0, w, h).data;

        const rowBytes = Math.ceil(w * 3 / 4) * 4;   // rows padded to 4 bytes
        const pixBytes = rowBytes * h;
        const fileSize = 54 + pixBytes;

        const buf  = new ArrayBuffer(fileSize);
        const view = new DataView(buf);

        // --- File header ---
        view.setUint8(0, 0x42); view.setUint8(1, 0x4D);  // "BM"
        view.setUint32(2,  fileSize, true);
        view.setUint32(6,  0,        true);               // reserved
        view.setUint32(10, 54,       true);               // pixel data offset

        // --- DIB header (BITMAPINFOHEADER, 40 bytes) ---
        view.setUint32(14, 40,       true);   // header size
        view.setInt32 (18, w,        true);   // width
        view.setInt32 (22, -h,       true);   // height (negative = top-down)
        view.setUint16(26, 1,        true);   // colour planes
        view.setUint16(28, 24,       true);   // bits per pixel
        view.setUint32(30, 0,        true);   // compression (none)
        view.setUint32(34, pixBytes, true);   // pixel data size
        view.setInt32 (38, 2835,     true);   // X ppm (~72 DPI)
        view.setInt32 (42, 2835,     true);   // Y ppm
        view.setUint32(46, 0,        true);   // colours in table
        view.setUint32(50, 0,        true);   // important colours

        // --- Pixel rows (top-down because of negative height) ---
        let off = 54;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;  // RGBA source index
                view.setUint8(off++, px[i + 2]);  // B
                view.setUint8(off++, px[i + 1]);  // G
                view.setUint8(off++, px[i    ]);  // R
            }
            const pad = rowBytes - w * 3;
            for (let p = 0; p < pad; p++) view.setUint8(off++, 0);
        }

        return new Uint8Array(buf);
    }

    // ── Boot ──────────────────────────────────────────────────────────────────
    buildPalette();

    // Close all group panels on init (HTML may have one open by default)
    document.querySelectorAll('.group-panel').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.group-toggle').forEach(b => { b.classList.remove('active'); b.classList.remove('open'); });

    // White background, then load existing BMP
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);

    const srcImg = new Image();
    srcImg.onload = () => { ctx.drawImage(srcImg, 0, 0); };
    srcImg.src = `/api/pages/${pageId}/content?type=bmp&t=${Date.now()}`;

    fitToScreen();
})();
