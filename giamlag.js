// ==UserScript==
// @name         Tiên Giới HH3D - Chấm Đỏ Siêu Mượt v4.0 (Đo FPS & Chống Khựng Khi Lướt)
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Xóa khựng khi lướt map và khi có người join; tích hợp bảng đo FPS/FrameTime/RAM/Lệnh vẽ đã chặn (có nút bật/tắt); tùy chỉnh ẩn/hiện nhân vật, ngoại cảnh, hiệu ứng.
// @author       Helper
// @match        *://hoathinh3d.day/game*
// @match        *://*.hoathinh3d.day/game*
// @include      *://hoathinh3d.*/game*
// @include      *://*.hoathinh3d.*/game*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // ================= CẤU HÌNH LƯU TRỮ =================
    const STORAGE_KEY = 'hh3d_reddot_v4_cfg';
    const defaultCfg = {
        showDots: true,         // Hiện chấm đỏ (1 người = 1 chấm)
        showNames: true,        // Hiện tên nhỏ dưới chấm đỏ
        showChars: false,       // Hiện nhân vật gốc
        showScenery: false,     // Hiện ngoại cảnh/map
        showFx: false,          // Hiện hiệu ứng/sương mù/ánh sáng
        blockPropsClick: true,  // Chặn ấn nhầm ghế/đèn/chuông
        lowDpr: true,           // Ép độ phân giải Canvas 1x (Chống khựng khi lướt)
        throttleInput: true,    // Đồng bộ tần số quét cảm ứng/chuột theo FPS khi lướt
        showPerfHud: true,      // Hiện bảng đo FPS & Hiệu năng
        dotRadius: 5,           // Cỡ chấm đỏ (px)
        nameSize: 9,            // Cỡ chữ tên (px)
        offsetY: -40            // Tâm click Y (Hitbox nhân vật)
    };

    let cfg = Object.assign({}, defaultCfg);
    try {
        const saved = win.localStorage.getItem(STORAGE_KEY);
        if (saved) cfg = Object.assign({}, defaultCfg, JSON.parse(saved));
    } catch (e) {}

    function saveCfg() {
        try {
            win.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
        } catch (e) {}
    }

    // ================= BỘ ĐẾM HIỆU NĂNG (FPS & LỆNH VẼ ĐÃ CHẶN) =================
    const perfStats = {
        frames: 0,
        lastTime: performance.now(),
        lastFrameAt: performance.now(),
        fps: 60,
        minFps: 60,
        avgFrameMs: 16.7,
        maxFrameMs: 16.7,
        frameMsSum: 0,
        skippedCalls: 0,
        skippedPerSec: 0,
        playersCount: 0,
        dotsDrawn: 0
    };

    // ================= 1. ÉP DPR 1x & TỐI ƯU ĐỒ HỌA GỐC (chunk-P423QZIB.js) =================
    const nativeDpr = win.devicePixelRatio || 1;
    try {
        Object.defineProperty(win, 'devicePixelRatio', {
            configurable: true,
            enumerable: true,
            get: function () {
                return cfg.lowDpr ? 1 : nativeDpr;
            }
        });
    } catch (e) {}

    function syncGameGfx() {
        const gfxObj = {
            quality: 'smooth',
            fps: 60,
            others: 'lite',
            ambient: !!cfg.showFx,
            renderer: 'canvas'
        };
        const raw = JSON.stringify(gfxObj);
        try {
            win.localStorage.setItem('hh3dg:gfx', raw);
            for (let i = 0; i < win.localStorage.length; i++) {
                const k = win.localStorage.key(i);
                if (k && k.endsWith('hh3dg:gfx')) {
                    win.localStorage.setItem(k, raw);
                }
            }
            if (win.__gfx && typeof win.__gfx.set === 'function') {
                win.__gfx.set(gfxObj);
            }
        } catch (e) {}
    }
    syncGameGfx();

    // Hạ chất lượng giải mã bitmap để tránh nghẽn CPU khi tải ảnh mới
    if (typeof win.createImageBitmap === 'function') {
        const origCreateImageBitmap = win.createImageBitmap;
        win.createImageBitmap = function (image, options) {
            if (options && typeof options === 'object' && options.resizeQuality === 'high') {
                return origCreateImageBitmap.call(this, image, Object.assign({}, options, { resizeQuality: 'low' }));
            }
            return origCreateImageBitmap.apply(this, arguments);
        };
    }

    // ================= 2. CHỐNG KHỰNG KHI LƯỚT (THROTTLE POINTERMOVE THEO RAF) =================
    const origAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
        if ((type === 'pointermove' || type === 'mousemove' || type === 'touchmove') && typeof listener === 'function' && !listener.__hh3dThrottled) {
            let ticking = false;
            let lastEvent = null;
            let lastThis = null;
            const wrapped = function (e) {
                if (!cfg.throttleInput || !isInHub()) {
                    return listener.apply(this, arguments);
                }
                lastEvent = e;
                lastThis = this;
                if (!ticking) {
                    ticking = true;
                    win.requestAnimationFrame(() => {
                        ticking = false;
                        if (lastEvent) listener.call(lastThis, lastEvent);
                    });
                }
            };
            wrapped.__hh3dThrottled = true;
            return origAddEventListener.call(this, type, wrapped, options);
        }
        return origAddEventListener.apply(this, arguments);
    };

    // ================= 3. HOOK SCENE (st) & INTERACTABLES (ut) (chunk-J5YHMUTR.js) =================
    let hubRef = null;
    let activeSceneInstances = new Set();
    let lastVisiblePlayers = null;
    let inSceneDraw = false;
    let inRedDotDraw = false;

    function isInHub() {
        return !!(document.body && document.body.classList.contains('in-hub'));
    }

    function isHubCanvas(c) {
        return !!(c && c.classList && c.classList.contains('hub-canvas'));
    }

    // Ngắt mảng dữ liệu ngoại cảnh khi tắt "Hiện ngoại cảnh" để hàm Kn(r, t) không tải ngầm 35 tấm nền 1024x1024 khi lướt
    function syncSceneDataArrays(stInstance) {
        if (!stInstance || !stInstance.env) return;
        const env = stInstance.env;
        if (!stInstance.__origSaved) {
            stInstance.__origSaved = true;
            stInstance.__origLayers = Array.isArray(env.layers) ? env.layers.slice() : [];
            stInstance.__origProps = Array.isArray(env.props) ? env.props.slice() : [];
            stInstance.__origTiles = Array.isArray(stInstance.tiles) ? stInstance.tiles.slice() : [];
        }
        if (!cfg.showScenery) {
            if (Array.isArray(env.layers)) env.layers.length = 0;
            if (Array.isArray(env.props)) env.props.length = 0;
            if (Array.isArray(stInstance.tiles)) stInstance.tiles.length = 0;
        } else {
            if (Array.isArray(env.layers) && env.layers.length === 0 && stInstance.__origLayers.length > 0) {
                env.layers.push(...stInstance.__origLayers);
            }
            if (Array.isArray(env.props) && env.props.length === 0 && stInstance.__origProps.length > 0) {
                env.props.push(...stInstance.__origProps);
            }
            if (Array.isArray(stInstance.tiles) && stInstance.tiles.length === 0 && stInstance.__origTiles.length > 0) {
                stInstance.tiles.push(...stInstance.__origTiles);
            }
        }
    }

    function syncAllScenes() {
        for (const st of activeSceneInstances) {
            syncSceneDataArrays(st);
        }
    }

    function wrapDrawableList(list) {
        if (!Array.isArray(list)) return list;
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (item && typeof item.draw === 'function' && !item.draw.__hh3dWrapped) {
                const origDraw = item.draw;
                const wrapped = function () {
                    inSceneDraw = true;
                    try {
                        return origDraw.apply(this, arguments);
                    } finally {
                        inSceneDraw = false;
                    }
                };
                wrapped.__hh3dWrapped = true;
                item.draw = wrapped;
            }
        }
        return list;
    }

    function drawRedDotsInWorld(ctx, h, visibleList) {
        const map = (h && h.members instanceof Map) ? h.members : null;
        perfStats.playersCount = map ? map.size : (Array.isArray(visibleList) ? visibleList.length : 0);

        if (!cfg.showDots || !ctx) {
            perfStats.dotsDrawn = 0;
            return;
        }

        const meObj = (h && typeof h.me === 'function') ? h.me() : null;
        const meUid = meObj ? meObj.uid : null;
        const drawnUids = new Set();
        const listToDraw = [];

        if (Array.isArray(visibleList)) {
            for (let i = 0; i < visibleList.length; i++) {
                const entry = visibleList[i];
                if (!entry || !Number.isFinite(entry.x) || !Number.isFinite(entry.y)) continue;
                const m = entry.m;
                const uid = m ? m.uid : ('v_' + i);
                if (drawnUids.has(uid)) continue;
                drawnUids.add(uid);
                listToDraw.push({
                    x: entry.x,
                    y: entry.y,
                    name: (m && m.name) ? m.name : '',
                    isMe: uid === meUid
                });
            }
        }

        if (map) {
            for (const m of map.values()) {
                if (!m || drawnUids.has(m.uid)) continue;
                const pos = (typeof h.posOf === 'function') ? h.posOf(m) : m;
                if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
                drawnUids.add(m.uid);
                listToDraw.push({
                    x: pos.x,
                    y: pos.y,
                    name: m.name || '',
                    isMe: m.uid === meUid
                });
            }
        }

        perfStats.dotsDrawn = listToDraw.length;
        if (!listToDraw.length) return;

        inRedDotDraw = true;
        try {
            origSave.call(ctx);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            ctx.shadowBlur = 0;

            const r = cfg.dotRadius;
            const offY = cfg.offsetY;
            const showNames = cfg.showNames;
            const fontSize = cfg.nameSize;

            if (showNames) {
                ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
            }

            ctx.lineWidth = 1.25;
            ctx.strokeStyle = '#ffffff';

            for (let i = 0; i < listToDraw.length; i++) {
                const p = listToDraw[i];
                const dx = p.x;
                const dy = p.y + offY;

                origBeginPath.call(ctx);
                origArc.call(ctx, dx, dy, r, 0, Math.PI * 2);
                ctx.fillStyle = p.isMe ? '#00e676' : '#ff2222';
                origFill.call(ctx);
                origStroke.call(ctx);

                if (showNames && p.name) {
                    ctx.fillStyle = p.isMe ? '#80ffc0' : '#ffe082';
                    origFillText.call(ctx, p.name, dx, dy + r + 2);
                }
            }

            origRestore.call(ctx);
        } finally {
            inRedDotDraw = false;
        }
    }

    function patchInteractablesProto(proto) {
        if (!proto || proto.__hh3dPatched) return;
        proto.__hh3dPatched = true;

        const origAt = proto.at;
        if (typeof origAt === 'function') {
            proto.at = function () {
                if (this.h) hubRef = this.h;
                if (cfg.blockPropsClick && (!cfg.showScenery || (cfg.showDots && !cfg.showChars))) return null;
                return origAt.apply(this, arguments);
            };
        }

        const origDrawables = proto.drawables;
        if (typeof origDrawables === 'function') {
            proto.drawables = function () {
                if (this.h) hubRef = this.h;
                if (!cfg.showScenery) {
                    this.pending = [];
                    return [];
                }
                return wrapDrawableList(origDrawables.apply(this, arguments));
            };
        }

        const origSeatExtra = proto.seatExtra;
        if (typeof origSeatExtra === 'function') {
            proto.seatExtra = function () {
                if (!cfg.showFx) return;
                inSceneDraw = true;
                try {
                    return origSeatExtra.apply(this, arguments);
                } finally {
                    inSceneDraw = false;
                }
            };
        }

        const origDrawQiLinks = proto.drawQiLinks;
        if (typeof origDrawQiLinks === 'function') {
            proto.drawQiLinks = function (ctx, players) {
                if (this.h) hubRef = this.h;
                if (Array.isArray(players)) lastVisiblePlayers = players;
                if (!cfg.showFx) return;
                inSceneDraw = true;
                try {
                    return origDrawQiLinks.apply(this, arguments);
                } finally {
                    inSceneDraw = false;
                }
            };
        }

        const origDrawFx = proto.drawFx;
        if (typeof origDrawFx === 'function') {
            proto.drawFx = function (ctx) {
                if (this.h) hubRef = this.h;
                if (cfg.showFx) {
                    inSceneDraw = true;
                    try {
                        origDrawFx.apply(this, arguments);
                    } finally {
                        inSceneDraw = false;
                    }
                } else {
                    if (this.parts) this.parts.length = 0;
                    if (this.texts) this.texts.length = 0;
                    if (this.dice) this.dice.length = 0;
                }
                drawRedDotsInWorld(ctx, this.h || hubRef, lastVisiblePlayers);
            };
        }

        const origDrawLabels = proto.drawLabels;
        if (typeof origDrawLabels === 'function') {
            proto.drawLabels = function () {
                if (!cfg.showScenery) {
                    this.pending = [];
                    return;
                }
                inSceneDraw = true;
                try {
                    return origDrawLabels.apply(this, arguments);
                } finally {
                    inSceneDraw = false;
                }
            };
        }
    }

    function patchSceneProto(proto) {
        if (!proto || proto.__hh3dPatched) return;
        proto.__hh3dPatched = true;

        const origTick = proto.tick;
        if (typeof origTick === 'function') {
            proto.tick = function () {
                activeSceneInstances.add(this);
                syncSceneDataArrays(this);
                return origTick.apply(this, arguments);
            };
        }

        const origActionAt = proto.actionAt;
        if (typeof origActionAt === 'function') {
            proto.actionAt = function () {
                if (cfg.blockPropsClick && !cfg.showScenery) return null;
                return origActionAt.apply(this, arguments);
            };
        }

        const origGroundCovers = proto.groundCovers;
        if (typeof origGroundCovers === 'function') {
            proto.groundCovers = function () {
                if (!cfg.showScenery) return false;
                return origGroundCovers.apply(this, arguments);
            };
        }

        const origDrawSky = proto.drawSky;
        if (typeof origDrawSky === 'function') {
            proto.drawSky = function (ctx, w, h) {
                inSceneDraw = true;
                try {
                    if (!cfg.showScenery) {
                        ctx.fillStyle = '#141820';
                        origFillRect.call(ctx, 0, 0, w, h);
                        return;
                    }
                    return origDrawSky.apply(this, arguments);
                } finally {
                    inSceneDraw = false;
                }
            };
        }

        const origDrawLayers = proto.drawLayers;
        if (typeof origDrawLayers === 'function') {
            proto.drawLayers = function () {
                if (!cfg.showScenery) return;
                inSceneDraw = true;
                try {
                    return origDrawLayers.apply(this, arguments);
                } finally {
                    inSceneDraw = false;
                }
            };
        }

        const origDrawGround = proto.drawGround;
        if (typeof origDrawGround === 'function') {
            proto.drawGround = function () {
                if (!cfg.showScenery) return;
                inSceneDraw = true;
                try {
                    return origDrawGround.apply(this, arguments);
                } finally {
                    inSceneDraw = false;
                }
            };
        }

        const origSceneDrawables = proto.drawables;
        if (typeof origSceneDrawables === 'function') {
            proto.drawables = function () {
                if (!cfg.showScenery) return [];
                return wrapDrawableList(origSceneDrawables.apply(this, arguments));
            };
        }

        const origDrawMist = proto.drawMist;
        if (typeof origDrawMist === 'function') {
            proto.drawMist = function () {
                if (!cfg.showScenery || !cfg.showFx) return;
                inSceneDraw = true;
                try {
                    return origDrawMist.apply(this, arguments);
                } finally {
                    inSceneDraw = false;
                }
            };
        }

        const origDrawLight = proto.drawLight;
        if (typeof origDrawLight === 'function') {
            proto.drawLight = function () {
                if (!cfg.showFx) return;
                inSceneDraw = true;
                try {
                    return origDrawLight.apply(this, arguments);
                } finally {
                    inSceneDraw = false;
                }
            };
        }
    }

    const origWeakSetAdd = WeakSet.prototype.add;
    WeakSet.prototype.add = function (obj) {
        if (obj && typeof obj === 'object') {
            if (typeof obj.drawQiLinks === 'function' && typeof obj.drawFx === 'function') {
                patchInteractablesProto(Object.getPrototypeOf(obj));
            } else if (typeof obj.drawSky === 'function' && typeof obj.groundCovers === 'function') {
                activeSceneInstances.add(obj);
                patchSceneProto(Object.getPrototypeOf(obj));
            }
        }
        return origWeakSetAdd.apply(this, arguments);
    };

    // ================= 4. HOOK CANVAS 2D TRIỆT TIÊU NGHẼN CPU/GPU KHI LƯỚT =================
    const Proto = win.CanvasRenderingContext2D && win.CanvasRenderingContext2D.prototype;
    if (!Proto) return;

    const origFillRect = Proto.fillRect;
    const origStrokeRect = Proto.strokeRect;
    const origDrawImage = Proto.drawImage;
    const origFill = Proto.fill;
    const origStroke = Proto.stroke;
    const origArc = Proto.arc;
    const origEllipse = Proto.ellipse;
    const origRect = Proto.rect;
    const origRoundRect = Proto.roundRect;
    const origBeginPath = Proto.beginPath;
    const origClosePath = Proto.closePath;
    const origMoveTo = Proto.moveTo;
    const origLineTo = Proto.lineTo;
    const origQuadraticCurveTo = Proto.quadraticCurveTo;
    const origBezierCurveTo = Proto.bezierCurveTo;
    const origClip = Proto.clip;
    const origFillText = Proto.fillText;
    const origStrokeText = Proto.strokeText;
    const origMeasureText = Proto.measureText;
    const origSave = Proto.save;
    const origRestore = Proto.restore;
    const origGetImageData = Proto.getImageData;
    const origPutImageData = Proto.putImageData;
    const origCreateLinearGradient = Proto.createLinearGradient;
    const origCreateRadialGradient = Proto.createRadialGradient;

    const dummyGradient = { addColorStop: function () {} };
    const textWidthCache = new Map();

    function shouldSkipDraw(ctx) {
        if (inSceneDraw || inRedDotDraw) return false;
        const c = ctx.canvas;
        if (!c) return false;

        if (isHubCanvas(c)) {
            return !cfg.showChars;
        }
        if (!cfg.showChars && c.classList && c.classList.contains('pc-cv')) {
            return true;
        }
        // Chặn toàn bộ việc vẽ/ghép trang phục paperdoll trên các canvas ẩn khi đang ở sảnh
        if (!cfg.showChars && c.isConnected === false && isInHub()) {
            return true;
        }
        return false;
    }

    // Cache measureText để không phải tính toán lại font chữ hàng nghìn lần khi kéo camera
    if (origMeasureText) {
        Proto.measureText = function (text) {
            if (!cfg.showChars && isInHub()) {
                const key = this.font + '|' + text;
                let cached = textWidthCache.get(key);
                if (!cached) {
                    cached = origMeasureText.call(this, text);
                    if (textWidthCache.size > 2000) textWidthCache.clear();
                    textWidthCache.set(key, cached);
                }
                return cached;
            }
            return origMeasureText.apply(this, arguments);
        };
    }

    // Chặn toàn bộ getImageData & putImageData trên Canvas ngầm (bao gồm cả khung 80x88) để không khựng khi có người join
    if (origGetImageData) {
        Proto.getImageData = function () {
            if (!cfg.showChars && (!this.canvas || !this.canvas.isConnected) && isInHub()) {
                perfStats.skippedCalls++;
                return new ImageData(1, 1);
            }
            return origGetImageData.apply(this, arguments);
        };
    }

    if (origPutImageData) {
        Proto.putImageData = function () {
            if (!cfg.showChars && (!this.canvas || !this.canvas.isConnected) && isInHub()) {
                perfStats.skippedCalls++;
                return;
            }
            return origPutImageData.apply(this, arguments);
        };
    }

    if (origCreateLinearGradient) {
        Proto.createLinearGradient = function () {
            if (shouldSkipDraw(this)) return dummyGradient;
            return origCreateLinearGradient.apply(this, arguments);
        };
    }

    if (origCreateRadialGradient) {
        Proto.createRadialGradient = function () {
            if (shouldSkipDraw(this)) return dummyGradient;
            return origCreateRadialGradient.apply(this, arguments);
        };
    }

    Proto.drawImage = function () {
        if (shouldSkipDraw(this)) {
            perfStats.skippedCalls++;
            return;
        }
        return origDrawImage.apply(this, arguments);
    };

    Proto.fill = function () {
        if (shouldSkipDraw(this)) {
            perfStats.skippedCalls++;
            return;
        }
        return origFill.apply(this, arguments);
    };

    Proto.stroke = function () {
        if (shouldSkipDraw(this)) {
            perfStats.skippedCalls++;
            return;
        }
        return origStroke.apply(this, arguments);
    };

    Proto.fillText = function () {
        if (shouldSkipDraw(this)) {
            perfStats.skippedCalls++;
            return;
        }
        return origFillText.apply(this, arguments);
    };

    Proto.strokeText = function () {
        if (shouldSkipDraw(this)) return;
        return origStrokeText.apply(this, arguments);
    };

    Proto.fillRect = function () {
        if (shouldSkipDraw(this)) {
            perfStats.skippedCalls++;
            return;
        }
        return origFillRect.apply(this, arguments);
    };

    Proto.strokeRect = function () {
        if (shouldSkipDraw(this)) return;
        return origStrokeRect.apply(this, arguments);
    };

    // Chặn dựng hình học phức tạp (bóng đổ, khung tên bo góc, hào quang) khi đang ẩn nhân vật
    Proto.beginPath = function () {
        if (shouldSkipDraw(this)) return;
        return origBeginPath.apply(this, arguments);
    };
    Proto.closePath = function () {
        if (shouldSkipDraw(this)) return;
        return origClosePath.apply(this, arguments);
    };
    Proto.moveTo = function () {
        if (shouldSkipDraw(this)) return;
        return origMoveTo.apply(this, arguments);
    };
    Proto.lineTo = function () {
        if (shouldSkipDraw(this)) return;
        return origLineTo.apply(this, arguments);
    };
    Proto.quadraticCurveTo = function () {
        if (shouldSkipDraw(this)) return;
        return origQuadraticCurveTo.apply(this, arguments);
    };
    Proto.bezierCurveTo = function () {
        if (shouldSkipDraw(this)) return;
        return origBezierCurveTo.apply(this, arguments);
    };
    Proto.arc = function () {
        if (shouldSkipDraw(this)) return;
        return origArc.apply(this, arguments);
    };
    Proto.ellipse = function () {
        if (shouldSkipDraw(this)) return;
        return origEllipse.apply(this, arguments);
    };
    Proto.rect = function () {
        if (shouldSkipDraw(this)) return;
        return origRect.apply(this, arguments);
    };
    if (origRoundRect) {
        Proto.roundRect = function () {
            if (shouldSkipDraw(this)) return;
            return origRoundRect.apply(this, arguments);
        };
    }
    Proto.clip = function () {
        if (shouldSkipDraw(this)) return;
        return origClip.apply(this, arguments);
    };

    // ================= 5. CSS TỐI ƯU HIỆU ỨNG & KHUNG POPUP =================
    let styleEl = null;
    function updateCSS() {
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'hh3d-v4-css';
            (document.head || document.documentElement).appendChild(styleEl);
        }

        let css = '';
        if (!cfg.showFx) {
            css += `
                *, *::before, *::after {
                    backdrop-filter: none !important;
                    -webkit-backdrop-filter: none !important;
                    box-shadow: none !important;
                    text-shadow: none !important;
                }
                #boot .bt-cloud, #boot .bt-scene, #boot .bt-gate, .area-banner {
                    display: none !important;
                }
            `;
        }
        if (!cfg.showChars) {
            css += `
                .pc-stage canvas.pc-cv,
                .pc-stage-back,
                .av img,
                .qp-av img,
                img[src*="profile_photo"] {
                    display: none !important;
                }
                .pc-stage {
                    min-height: 0 !important;
                    height: auto !important;
                    padding: 0 !important;
                }
            `;
        }
        if (!cfg.showScenery) {
            css += `
                body.in-hub, .view.hub {
                    background: #141820 !important;
                }
            `;
        }
        styleEl.textContent = css;
    }

    if (document.head || document.documentElement) {
        updateCSS();
    } else {
        win.addEventListener('DOMContentLoaded', updateCSS);
    }

    // ================= 6. VÒNG ĐO FPS & BẢNG HIỂN THỊ HIỆU NĂNG (CÓ BẬT/TẮT) =================
    let hudBox = null;
    let hudFpsEl = null;
    let hudMsEl = null;
    let hudSkipEl = null;
    let hudRamEl = null;
    let hudPlrEl = null;

    function startPerfMonitor() {
        let minFrameFps = 120;
        let maxFrameDelta = 0;

        function measureLoop(now) {
            win.requestAnimationFrame(measureLoop);
            if (!cfg.showPerfHud) return;

            const dt = now - perfStats.lastFrameAt;
            perfStats.lastFrameAt = now;
            perfStats.frames++;
            perfStats.frameMsSum += dt;

            if (dt > maxFrameDelta) maxFrameDelta = dt;
            const instFps = dt > 0 ? (1000 / dt) : 60;
            if (instFps < minFrameFps) minFrameFps = instFps;

            const elapsed = now - perfStats.lastTime;
            if (elapsed >= 500) {
                perfStats.fps = Math.min(120, Math.round((perfStats.frames * 1000) / elapsed));
                perfStats.avgFrameMs = +(perfStats.frameMsSum / perfStats.frames).toFixed(1);
                perfStats.maxFrameMs = +maxFrameDelta.toFixed(1);
                perfStats.minFps = Math.max(0, Math.min(perfStats.fps, Math.round(minFrameFps)));
                perfStats.skippedPerSec = Math.round((perfStats.skippedCalls * 1000) / elapsed);

                perfStats.frames = 0;
                perfStats.frameMsSum = 0;
                perfStats.skippedCalls = 0;
                perfStats.lastTime = now;
                minFrameFps = 120;
                maxFrameDelta = 0;

                updatePerfHudDOM();
            }
        }
        win.requestAnimationFrame(measureLoop);
    }

    function updatePerfHudDOM() {
        if (!hudBox || !cfg.showPerfHud) return;

        const fpsColor = perfStats.fps >= 50 ? '#4ade80' : (perfStats.fps >= 30 ? '#facc15' : '#f87171');
        if (hudFpsEl) {
            hudFpsEl.style.color = fpsColor;
            hudFpsEl.textContent = `${perfStats.fps} FPS (Thấp: ${perfStats.minFps})`;
        }
        if (hudMsEl) {
            const spikeWarn = perfStats.maxFrameMs > 35 ? '#f87171' : '#cbd5e1';
            hudMsEl.style.color = spikeWarn;
            hudMsEl.textContent = `Trễ: ${perfStats.avgFrameMs}ms (Đỉnh: ${perfStats.maxFrameMs}ms)`;
        }
        if (hudPlrEl) {
            hudPlrEl.textContent = `Sảnh: ${perfStats.playersCount} người (${perfStats.dotsDrawn} chấm) | DPR: ${win.devicePixelRatio}x`;
        }
        if (hudSkipEl) {
            hudSkipEl.textContent = `Đã chặn: ~${perfStats.skippedPerSec.toLocaleString('vi-VN')} lệnh vẽ/s`;
        }
        if (hudRamEl && performance && performance.memory) {
            const usedMb = Math.round(performance.memory.usedJSHeapSize / 1048576);
            const totalMb = Math.round(performance.memory.totalJSHeapSize / 1048576);
            hudRamEl.textContent = `RAM JS: ${usedMb}/${totalMb} MB`;
        }
    }

    // ================= 7. GIAO DIỆN ĐIỀU KHIỂN & BẢNG ĐO SIÊU NHỎ =================
    function createUI() {
        if (document.getElementById('hh3d-v4-ui')) return;

        // 1. Bảng đo FPS & Hiệu năng (Góc dưới bên trái, ngay trên thanh nút)
        hudBox = document.createElement('div');
        hudBox.id = 'hh3d-v4-hud';
        hudBox.style.cssText = `
            position: fixed;
            bottom: 30px;
            left: 6px;
            z-index: 999998;
            background: rgba(15, 20, 28, 0.88);
            border: 1px solid rgba(255, 255, 255, 0.22);
            border-radius: 6px;
            padding: 4px 7px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 9.5px;
            line-height: 1.35;
            color: #e2e8f0;
            user-select: none;
            pointer-events: auto;
            display: ${cfg.showPerfHud ? 'flex' : 'none'};
            flex-direction: column;
            gap: 1px;
            min-width: 158px;
        `;

        const hasMemoryApi = !!(performance && performance.memory);
        hudBox.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;border-bottom:1px solid rgba(255,255,255,0.12);padding-bottom:2px;margin-bottom:1px;">
                <b id="hh3d-hud-fps" style="color:#4ade80;font-size:10px;">60 FPS</b>
                <span id="hh3d-hud-close" style="cursor:pointer;padding:0 3px;color:#94a3b8;font-weight:bold;" title="Ẩn bảng đo FPS">✕</span>
            </div>
            <div id="hh3d-hud-ms">Trễ: 16.7ms (Đỉnh: 16.7ms)</div>
            <div id="hh3d-hud-plr">Sảnh: 0 người | DPR: 1x</div>
            <div id="hh3d-hud-skip" style="color:#38bdf8;">Đã chặn: 0 lệnh vẽ/s</div>
            <div id="hh3d-hud-ram" style="color:#a78bfa;display:${hasMemoryApi ? 'block' : 'none'};">RAM JS: -- MB</div>
        `;
        document.body.appendChild(hudBox);

        hudFpsEl = document.getElementById('hh3d-hud-fps');
        hudMsEl = document.getElementById('hh3d-hud-ms');
        hudPlrEl = document.getElementById('hh3d-hud-plr');
        hudSkipEl = document.getElementById('hh3d-hud-skip');
        hudRamEl = document.getElementById('hh3d-hud-ram');

        // 2. Thanh nút nhỏ gọn & Menu tùy chọn
        const wrap = document.createElement('div');
        wrap.id = 'hh3d-v4-ui';
        wrap.style.cssText = `
            position: fixed;
            bottom: 6px;
            left: 6px;
            z-index: 999999;
            font-family: system-ui, -apple-system, sans-serif;
            font-size: 10px;
            line-height: 1.2;
            color: #fff;
            user-select: none;
        `;

        wrap.innerHTML = `
            <div style="display:inline-flex;align-items:center;gap:4px;">
                <div id="hh3d-v4-toggle" style="
                    background: rgba(20, 24, 32, 0.88);
                    color: #fff;
                    padding: 3px 7px;
                    border-radius: 6px;
                    font-weight: 600;
                    font-size: 10px;
                    cursor: pointer;
                    border: 1px solid rgba(255,255,255,0.35);
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                " title="Mở bảng tùy chọn">
                    <span id="hh3d-v4-dot-ic" style="width:6px;height:6px;border-radius:50%;background:${cfg.showDots ? '#ff2222' : '#9ca3af'};display:inline-block;"></span>
                    <span>Tối ưu ▾</span>
                </div>
                <div id="hh3d-v4-hud-btn" style="
                    background: ${cfg.showPerfHud ? 'rgba(16, 185, 129, 0.85)' : 'rgba(55, 65, 81, 0.85)'};
                    color: #fff;
                    padding: 3px 6px;
                    border-radius: 6px;
                    font-weight: 700;
                    font-size: 9.5px;
                    cursor: pointer;
                    border: 1px solid rgba(255,255,255,0.35);
                " title="Bật/Tắt bảng đo FPS & Hiệu năng">FPS</div>
            </div>

            <div id="hh3d-v4-panel" style="
                display: none;
                margin-top: 4px;
                background: rgba(18, 22, 30, 0.96);
                border: 1px solid rgba(255,255,255,0.28);
                border-radius: 8px;
                padding: 7px 8px;
                width: 178px;
                flex-direction: column;
                gap: 5px;
                font-size: 10px;
            ">
                <div style="display:flex;gap:4px;margin-bottom:2px;">
                    <button id="hh3d-v4-preset-min" type="button" style="flex:1;background:#b91c1c;color:#fff;border:0;border-radius:4px;padding:3px 2px;font-size:9px;font-weight:700;cursor:pointer;">Tắt hết (Mượt)</button>
                    <button id="hh3d-v4-preset-all" type="button" style="flex:1;background:#2563eb;color:#fff;border:0;border-radius:4px;padding:3px 2px;font-size:9px;font-weight:700;cursor:pointer;">Hiện lại hết</button>
                </div>

                <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
                    <span>📊 Bảng đo FPS & Hiệu năng:</span>
                    <input type="checkbox" id="hh3d-v4-perf" style="margin:0;width:12px;height:12px;" ${cfg.showPerfHud ? 'checked' : ''}>
                </label>
                <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
                    <span>⚡ Hạ DPR 1x (Lướt siêu mượt):</span>
                    <input type="checkbox" id="hh3d-v4-dpr" style="margin:0;width:12px;height:12px;" ${cfg.lowDpr ? 'checked' : ''}>
                </label>
                <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
                    <span>Hiện chấm đỏ:</span>
                    <input type="checkbox" id="hh3d-v4-dots" style="margin:0;width:12px;height:12px;" ${cfg.showDots ? 'checked' : ''}>
                </label>
                <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
                    <span>Hiện tên nhỏ:</span>
                    <input type="checkbox" id="hh3d-v4-names" style="margin:0;width:12px;height:12px;" ${cfg.showNames ? 'checked' : ''}>
                </label>
                <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
                    <span>Hiện nhân vật:</span>
                    <input type="checkbox" id="hh3d-v4-chars" style="margin:0;width:12px;height:12px;" ${cfg.showChars ? 'checked' : ''}>
                </label>
                <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
                    <span>Hiện ngoại cảnh:</span>
                    <input type="checkbox" id="hh3d-v4-scenery" style="margin:0;width:12px;height:12px;" ${cfg.showScenery ? 'checked' : ''}>
                </label>
                <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
                    <span>Hiện hiệu ứng:</span>
                    <input type="checkbox" id="hh3d-v4-fx" style="margin:0;width:12px;height:12px;" ${cfg.showFx ? 'checked' : ''}>
                </label>
                <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
                    <span>Chặn ấn nhầm ghế:</span>
                    <input type="checkbox" id="hh3d-v4-nopop" style="margin:0;width:12px;height:12px;" ${cfg.blockPropsClick ? 'checked' : ''}>
                </label>

                <div style="border-top:1px solid rgba(255,255,255,0.12);padding-top:4px;display:flex;flex-direction:column;gap:3px;">
                    <div style="display:flex;justify-content:space-between;">
                        <span>Cỡ chấm: <b id="hh3d-v4-rv">${cfg.dotRadius}</b></span>
                        <span>Cỡ tên: <b id="hh3d-v4-nv">${cfg.nameSize}</b></span>
                    </div>
                    <div style="display:flex;gap:4px;">
                        <input type="range" id="hh3d-v4-r" min="3" max="14" step="1" value="${cfg.dotRadius}" style="width:50%;margin:0;">
                        <input type="range" id="hh3d-v4-n" min="6" max="14" step="1" value="${cfg.nameSize}" style="width:50%;margin:0;">
                    </div>
                    <div style="display:flex;justify-content:space-between;">
                        <span>Tâm Click Y:</span>
                        <b id="hh3d-v4-yv">${cfg.offsetY}</b>
                    </div>
                    <input type="range" id="hh3d-v4-y" min="-70" max="0" step="2" value="${cfg.offsetY}" style="width:100%;margin:0;">
                </div>
            </div>
        `;

        document.body.appendChild(wrap);

        const toggleBtn = document.getElementById('hh3d-v4-toggle');
        const hudBtn = document.getElementById('hh3d-v4-hud-btn');
        const hudClose = document.getElementById('hh3d-hud-close');
        const panel = document.getElementById('hh3d-v4-panel');
        const dotIc = document.getElementById('hh3d-v4-dot-ic');

        const chkPerf = document.getElementById('hh3d-v4-perf');
        const chkDpr = document.getElementById('hh3d-v4-dpr');
        const chkDots = document.getElementById('hh3d-v4-dots');
        const chkNames = document.getElementById('hh3d-v4-names');
        const chkChars = document.getElementById('hh3d-v4-chars');
        const chkScenery = document.getElementById('hh3d-v4-scenery');
        const chkFx = document.getElementById('hh3d-v4-fx');
        const chkNopop = document.getElementById('hh3d-v4-nopop');

        function setPerfHudVisible(on) {
            cfg.showPerfHud = !!on;
            chkPerf.checked = cfg.showPerfHud;
            hudBox.style.display = cfg.showPerfHud ? 'flex' : 'none';
            hudBtn.style.background = cfg.showPerfHud ? 'rgba(16, 185, 129, 0.85)' : 'rgba(55, 65, 81, 0.85)';
            saveCfg();
        }

        function refreshAll() {
            chkPerf.checked = cfg.showPerfHud;
            chkDpr.checked = cfg.lowDpr;
            chkDots.checked = cfg.showDots;
            chkNames.checked = cfg.showNames;
            chkChars.checked = cfg.showChars;
            chkScenery.checked = cfg.showScenery;
            chkFx.checked = cfg.showFx;
            chkNopop.checked = cfg.blockPropsClick;
            dotIc.style.background = cfg.showDots ? '#ff2222' : '#9ca3af';
            hudBox.style.display = cfg.showPerfHud ? 'flex' : 'none';
            hudBtn.style.background = cfg.showPerfHud ? 'rgba(16, 185, 129, 0.85)' : 'rgba(55, 65, 81, 0.85)';
            saveCfg();
            updateCSS();
            syncGameGfx();
            syncAllScenes();
        }

        toggleBtn.addEventListener('click', () => {
            panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
        });

        hudBtn.addEventListener('click', () => {
            setPerfHudVisible(!cfg.showPerfHud);
        });

        hudClose.addEventListener('click', () => {
            setPerfHudVisible(false);
        });

        document.getElementById('hh3d-v4-preset-min').addEventListener('click', () => {
            cfg.showDots = true;
            cfg.showNames = true;
            cfg.showChars = false;
            cfg.showScenery = false;
            cfg.showFx = false;
            cfg.blockPropsClick = true;
            cfg.lowDpr = true;
            refreshAll();
            win.dispatchEvent(new Event('resize'));
        });

        document.getElementById('hh3d-v4-preset-all').addEventListener('click', () => {
            cfg.showChars = true;
            cfg.showScenery = true;
            cfg.showFx = true;
            cfg.blockPropsClick = false;
            refreshAll();
        });

        chkPerf.addEventListener('change', (e) => setPerfHudVisible(e.target.checked));
        chkDpr.addEventListener('change', (e) => {
            cfg.lowDpr = e.target.checked;
            refreshAll();
            // Phát sự kiện resize để game cập nhật lại độ phân giải Canvas ngay lập tức
            win.dispatchEvent(new Event('resize'));
        });
        chkDots.addEventListener('change', (e) => { cfg.showDots = e.target.checked; refreshAll(); });
        chkNames.addEventListener('change', (e) => { cfg.showNames = e.target.checked; refreshAll(); });
        chkChars.addEventListener('change', (e) => { cfg.showChars = e.target.checked; refreshAll(); });
        chkScenery.addEventListener('change', (e) => { cfg.showScenery = e.target.checked; refreshAll(); });
        chkFx.addEventListener('change', (e) => { cfg.showFx = e.target.checked; refreshAll(); });
        chkNopop.addEventListener('change', (e) => { cfg.blockPropsClick = e.target.checked; refreshAll(); });

        document.getElementById('hh3d-v4-r').addEventListener('input', (e) => {
            cfg.dotRadius = parseInt(e.target.value, 10);
            document.getElementById('hh3d-v4-rv').textContent = cfg.dotRadius;
            saveCfg();
        });

        document.getElementById('hh3d-v4-n').addEventListener('input', (e) => {
            cfg.nameSize = parseInt(e.target.value, 10);
            document.getElementById('hh3d-v4-nv').textContent = cfg.nameSize;
            saveCfg();
        });

        document.getElementById('hh3d-v4-y').addEventListener('input', (e) => {
            cfg.offsetY = parseInt(e.target.value, 10);
            document.getElementById('hh3d-v4-yv').textContent = cfg.offsetY;
            saveCfg();
        });

        startPerfMonitor();
    }

    if (document.body) {
        createUI();
    } else {
        win.addEventListener('DOMContentLoaded', createUI);
    }
})();
