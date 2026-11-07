// ==UserScript==
// @name         Subtitle Sniffer (.vtt)
// @namespace    local.subtitle.sniffer
// @version      1.6
// @description  Detecta subtítulos (.vtt/.srt/.ttml/HLS) en páginas con video y los descarga como VTT, SRT o ASS
// @match        *://*/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      *
// @connect      rumble.cloud
// ==/UserScript==

(function () {
  'use strict';

  // true  = el botón "CC subs" aparece solo cuando se detectan subtítulos
  // false = el botón nunca aparece solo; se abre únicamente desde el menú del gestor de scripts
  const AUTO_BUTTON = true;

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const found = new Map(); // url -> {url, kind: 'file'|'hls', label}
  const SUB_RE = /\.(vtt|webvtt|srt|ttml|dfxp)(\?|#|$)/i;
  const M3U8_RE = /\.m3u8(\?|#|$)/i;

  const abs = (u, base) => { try { return new URL(u, base || location.href).href; } catch { return null; } };

  function add(url, kind, label) {
    if (!url || found.has(url)) return;
    found.set(url, { url, kind, label: label || '' });
    render();
  }

  // ---------- Detección ----------
  function parseM3u8(text, base) {
    if (!text || !text.startsWith('#EXTM3U')) return;
    const lines = text.split(/\r?\n/);
    let hasMedia = false;
    for (const l of lines) {
      if (l.startsWith('#EXT-X-MEDIA') && /TYPE=SUBTITLES/i.test(l)) {
        const uri = (l.match(/URI="([^"]+)"/) || [])[1];
        const name = (l.match(/NAME="([^"]+)"/) || [])[1] || (l.match(/LANGUAGE="([^"]+)"/) || [])[1] || '';
        if (uri) { add(abs(uri, base), 'hls', name); hasMedia = true; }
      }
    }
    if (!hasMedia) {
      // ¿es una playlist de segmentos .vtt?
      const segs = lines.filter(l => l && !l.startsWith('#') && /\.(vtt|webvtt)(\?|$)/i.test(l));
      if (segs.length) add(base, 'hls', 'playlist');
    }
  }

  function inspect(url, textPromiseFn) {
    const u = abs(url);
    if (!u) return;
    if (SUB_RE.test(u)) add(u, 'file');
    else if (M3U8_RE.test(u) && textPromiseFn) textPromiseFn().then(t => parseM3u8(t, u)).catch(() => {});
  }

  // Hook fetch
  const origFetch = W.fetch;
  if (origFetch) {
    W.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;
        inspect(url, () => p.then(r => r.clone().text()));
      } catch {}
      return p;
    };
  }

  // Hook XHR
  const XO = W.XMLHttpRequest && W.XMLHttpRequest.prototype.open;
  if (XO) {
    W.XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.addEventListener('load', () => {
          inspect(url, () => Promise.resolve(
            (this.responseType === '' || this.responseType === 'text') ? this.responseText : ''
          ));
        });
      } catch {}
      return XO.apply(this, arguments);
    };
  }

  // <track> elements
  function scanTracks() {
    document.querySelectorAll('track[src]').forEach(t => {
      const u = abs(t.src);
      if (u && !found.has(u)) add(u, 'file', t.label || t.srclang || '');
    });
  }

  // ---------- Conversión a VTT (TTML, SRT) ----------
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  function fmtTime(ms) {
    ms = Math.max(0, Math.round(ms));
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
  }

  function parseTime(s, tick) {
    if (s == null || s === '') return NaN;
    s = String(s).trim();
    let m;
    if ((m = s.match(/^(\d+):(\d+):(\d+(?:[.,]\d+)?)$/))) return (+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3].replace(',', '.'))) * 1000;
    if ((m = s.match(/^(\d+):(\d+(?:[.,]\d+)?)$/))) return (+m[1] * 60 + parseFloat(m[2].replace(',', '.'))) * 1000;
    if ((m = s.match(/^([\d.]+)ms$/))) return +m[1];
    if ((m = s.match(/^([\d.]+)s$/))) return +m[1] * 1000;
    if ((m = s.match(/^([\d.]+)m$/))) return +m[1] * 60000;
    if ((m = s.match(/^([\d.]+)h$/))) return +m[1] * 3600000;
    if ((m = s.match(/^(\d+)t$/))) return (+m[1] / (tick || 10000000)) * 1000;
    if (/^[\d.]+$/.test(s)) return parseFloat(s) * 1000;
    return NaN;
  }

  function decodeEntities(s) {
    if (!s || s.indexOf('&') < 0) return s;
    const t = document.createElement('textarea');
    t.innerHTML = s;
    return t.value;
  }

  function nodeText(n) {
    let out = '';
    n.childNodes.forEach(c => {
      if (c.nodeType === 3 || c.nodeType === 4) out += c.nodeValue;
      else if (c.nodeType === 1) out += (c.localName === 'br') ? '\n' : nodeText(c);
    });
    return out;
  }

  function cuesToVTT(cues) {
    let out = 'WEBVTT\n\n';
    for (const c of cues) {
      const text = decodeEntities(c.text || '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
      if (!text || !isFinite(c.start) || !isFinite(c.end)) continue;
      out += `${fmtTime(c.start)} --> ${fmtTime(Math.max(c.end, c.start + 1))}\n${text}\n\n`;
    }
    return out;
  }

  function toVTT(raw) {
    const text = raw.replace(/^\uFEFF/, '');
    if (/^WEBVTT/.test(text)) return text;
    const t = text.trim();

    // TTML / DFXP
    if (t[0] === '<') {
      const doc = new DOMParser().parseFromString(t, 'text/xml');
      if (!doc.getElementsByTagName('parsererror').length && doc.documentElement.localName === 'tt') {
        const tick = parseFloat(doc.documentElement.getAttribute('ttp:tickRate')) || 0;
        const cues = Array.from(doc.getElementsByTagNameNS('*', 'p')).map(p => {
          const start = parseTime(p.getAttribute('begin'), tick);
          let end = parseTime(p.getAttribute('end'), tick);
          if (!isFinite(end)) end = start + parseTime(p.getAttribute('dur'), tick);
          return { start, end, text: nodeText(p) };
        });
        if (cues.length) return cuesToVTT(cues);
      }
    }

    // SRT
    return 'WEBVTT\n\n' + t.replace(/\r/g, '').replace(/(\d+:\d+:\d+),(\d+)/g, '$1.$2') + '\n';
  }

  // ---------- Conversión desde VTT a SRT / ASS ----------
  function parseVTT(vtt) {
    const cues = [];
    const re = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)\s*-->\s*(?:(\d+):)?(\d+):(\d+)[.,](\d+)/;
    const ms = (h, m, s, f) => ((+h || 0) * 3600 + +m * 60 + +s) * 1000 + +((f + '00').slice(0, 3));
    for (const block of vtt.replace(/\r/g, '').split(/\n{2,}/)) {
      const lines = block.split('\n');
      const i = lines.findIndex(l => l.includes('-->'));
      if (i < 0) continue;
      const m = lines[i].match(re);
      if (!m) continue;
      const text = lines.slice(i + 1).join('\n').trim();
      if (!text) continue;
      cues.push({ start: ms(m[1], m[2], m[3], m[4]), end: ms(m[5], m[6], m[7], m[8]), text });
    }
    return cues;
  }

  // quita etiquetas propias de VTT (<c>, <v>, <00:00:01.000>...) menos <i>, <b>, <u>
  const stripOther = s => s.replace(/<(?!\/?(?:i|b|u)>)[^>]*>/gi, '');
  const unent = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&lrm;|&rlm;/g, '').replace(/&amp;/g, '&');

  function toSRT(cues) {
    return cues.map((c, i) =>
      `${i + 1}\n${fmtTime(c.start).replace('.', ',')} --> ${fmtTime(c.end).replace('.', ',')}\n${unent(stripOther(c.text))}\n`
    ).join('\n');
  }

  function assTime(ms) {
    const cs = Math.round(ms / 10);
    return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
  }

  function toASS(cues) {
    let out = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: 1280',
      'PlayResY: 720',
      'WrapStyle: 0',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,30,1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ].join('\n') + '\n';
    for (const c of cues) {
      let t = stripOther(c.text).replace(/[{}]/g, m => (m === '{' ? '(' : ')'));
      t = t.replace(/<(\/?)([ibu])>/gi, (_, close, tag) => `{\\${tag.toLowerCase()}${close ? 0 : 1}}`);
      t = unent(t).replace(/\n/g, '\\N');
      out += `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${t}\n`;
    }
    return out;
  }

  // ---------- Descarga ----------
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'undefined') return reject(new Error('sin GM_xmlhttpRequest'));
      GM_xmlhttpRequest({
        method: 'GET', url,
        onload: r => (r.status >= 200 && r.status < 300) ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)),
        onerror: () => reject(new Error('error de red/CORS')), ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  // 1) fetch normal (sin prompt de ScriptCat); 2) GM_xmlhttpRequest como respaldo
  async function get(url) {
    try {
      const f = (origFetch || fetch).bind(W);
      const r = await f(url, { credentials: 'omit' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      if (/^(blob|data):/i.test(url)) throw e;
      return gmGet(url);
    }
  }

  // ---------- Nombre del video ----------
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  function stripSite(t) {
    const metaSite = document.querySelector('meta[property="og:site_name"]');
    const host = location.hostname.replace(/^www\./, '').split('.');
    const names = [metaSite && metaSite.content, host.length > 1 ? host[host.length - 2] : host[0]]
      .map(x => clean(x).toLowerCase()).filter(Boolean);
    const parts = t.split(/\s+[-|–—·•:]\s+/);
    if (parts.length < 2) return t;
    const isSite = p => names.some(n => p.toLowerCase().includes(n) || n.includes(p.toLowerCase()));
    const kept = parts.filter(p => !isSite(p));
    return kept.length ? kept.join(' - ') : t;
  }

  function getVideoTitle(fallbackUrl) {
    const cands = [];
    const meta = sel => { const e = document.querySelector(sel); return e && e.getAttribute('content'); };

    // JSON-LD (VideoObject / Movie / Episode)
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      try {
        const walk = o => {
          if (!o || typeof o !== 'object') return;
          if (Array.isArray(o)) return o.forEach(walk);
          const type = [].concat(o['@type'] || []).join(',');
          if (/VideoObject|Movie|Episode/i.test(type) && o.name) cands.push(o.name);
          Object.values(o).forEach(walk);
        };
        walk(JSON.parse(s.textContent));
      } catch {}
    });

    cands.push(meta('meta[property="og:video:title"]'), meta('meta[property="og:title"]'),
               meta('meta[name="twitter:title"]'), meta('meta[itemprop="name"]'));

    const v = document.querySelector('video');
    if (v) {
      const wrap = v.closest('[title]');
      cands.push(v.getAttribute('title'), v.getAttribute('aria-label'), wrap && wrap.getAttribute('title'));
    }
    const h1 = document.querySelector('h1');
    if (h1) cands.push(h1.textContent);
    cands.push(document.title);

    for (const c of cands) {
      const t = stripSite(clean(c));
      if (t && t.length > 1) return t;
    }
    // último recurso: nombre del archivo de subtítulo
    try {
      const f = decodeURIComponent(new URL(fallbackUrl).pathname.split('/').pop() || '');
      return f.replace(/\.(vtt|webvtt|srt|ttml|dfxp|m3u8)$/i, '') || 'subtitles';
    } catch { return 'subtitles'; }
  }

  function save(text, label, url, ext = 'vtt') {
    const base = getVideoTitle(url).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\.+$/, '').slice(0, 120);
    const name = `${base}${label ? '.' + label.replace(/[\\/:*?"<>|\s]+/g, '_') : ''}.${ext}`;
    const blob = new Blob([text], { type: (ext === 'vtt' ? 'text/vtt' : 'text/plain') + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  // Obtiene el subtítulo como texto VTT (a partir de VTT/SRT/TTML o de una playlist HLS)
  async function getVTT(item) {
    if (item.kind === 'file') {
      const text = await get(item.url);
      if (!text || !text.trim()) throw new Error('respuesta vacía; activa los subtítulos en el reproductor y reintenta');
      return toVTT(text);
    }
    const pl = await get(item.url);
    const segs = pl.split(/\r?\n/).filter(l => l && !l.startsWith('#')).map(l => abs(l, item.url));
    let out = 'WEBVTT\n\n';
    for (const s of segs) {
      let t = await get(s);
      t = t.replace(/^\uFEFF?WEBVTT[^\n]*\n(?:[^\n]+\n)*?\n/, ''); // quita cabecera de cada segmento
      out += t.trim() + '\n\n';
    }
    return out;
  }

  async function download(item, fmt = 'vtt', label = item.label, quiet = false) {
    try {
      if (!item.vtt) item.vtt = await getVTT(item); // se cachea para no volver a pedirlo
      let out = item.vtt;
      if (fmt !== 'vtt') {
        const cues = parseVTT(item.vtt);
        if (!cues.length) throw new Error('no se encontraron líneas de subtítulo');
        out = fmt === 'srt' ? toSRT(cues) : toASS(cues);
      }
      save(out, label, item.url, fmt);
      return true;
    } catch (e) {
      if (!quiet) alert('Error descargando subtítulo: ' + e.message);
      return false;
    }
  }

  let downloadingAll = false;
  async function downloadAll(fmt) {
    if (downloadingAll) return;
    downloadingAll = true;
    try {
      const items = Array.from(found.values());
      const used = new Map();
      let failed = 0;
      for (const [i, item] of items.entries()) {
        // nombres únicos para que un archivo no pise a otro
        let label = item.label || `sub${i + 1}`;
        const k = (used.get(label) || 0) + 1;
        used.set(label, k);
        if (k > 1) label += `_${k}`;
        if (!(await download(item, fmt, label, true))) failed++;
        await new Promise(r => setTimeout(r, 400)); // pausa para que el navegador no bloquee descargas seguidas
      }
      if (failed) alert(`${failed} de ${items.length} subtítulos no se pudieron descargar`);
    } finally {
      downloadingAll = false;
    }
  }

  // ---------- UI ----------
  // El panel solo se crea cuando hay subtítulos detectados (AUTO_BUTTON) o cuando se abre desde el menú.
  let box, list, btn;
  let manualOpen = false;

  function build() {
    if (box || !document.body) return;
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;font:13px sans-serif;';
    btn = document.createElement('button');
    btn.style.cssText = 'padding:6px 10px;border-radius:6px;border:0;background:#222;color:#fff;cursor:pointer;opacity:.85;';
    list = document.createElement('div');
    list.style.cssText = 'display:none;margin-bottom:6px;max-width:360px;max-height:50vh;overflow:auto;background:#fff;color:#000;border:1px solid #888;border-radius:6px;padding:6px;';
    btn.onclick = () => { list.style.display = list.style.display === 'none' ? 'block' : 'none'; };
    box.append(list, btn);
    document.body.appendChild(box);
  }

  function render() {
    const visible = manualOpen || (AUTO_BUTTON && found.size > 0);
    if (!visible) { if (box) box.style.display = 'none'; return; }
    build();
    if (!box) return; // body aún no existe; se reintenta en DOMContentLoaded
    box.style.display = '';
    btn.textContent = `CC subs (${found.size})`;
    list.textContent = '';
    if (!found.size) { list.textContent = 'Nada detectado aún. Activa los subtítulos en el reproductor.'; return; }
    if (found.size > 1) {
      const head = document.createElement('div');
      head.style.cssText = 'margin-bottom:6px;padding-bottom:6px;border-bottom:2px solid #888;';
      const t = document.createElement('div');
      t.style.cssText = 'font-weight:bold;';
      t.textContent = `Descargar todos (${found.size})`;
      const hb = document.createElement('div');
      hb.style.cssText = 'margin-top:3px;display:flex;gap:4px;';
      for (const fmt of ['vtt', 'srt', 'ass']) {
        const b = document.createElement('button');
        b.textContent = `↓ todos .${fmt}`;
        b.style.cssText = 'cursor:pointer;';
        b.onclick = () => downloadAll(fmt);
        hb.appendChild(b);
      }
      head.append(t, hb);
      list.appendChild(head);
    }
    for (const item of found.values()) {
      const row = document.createElement('div');
      row.style.cssText = 'margin:4px 0;padding-bottom:4px;border-bottom:1px solid #ddd;';
      const n = Array.from(found.values()).indexOf(item) + 1;
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:bold;';
      title.textContent = item.label || `Subtítulo ${n}`;
      const info = document.createElement('div');
      info.style.cssText = 'word-break:break-all;font-size:10px;color:#555;';
      info.textContent = `[${item.kind}] ${item.url}`;
      const btns = document.createElement('div');
      btns.style.cssText = 'margin-top:3px;display:flex;gap:4px;';
      for (const fmt of ['vtt', 'srt', 'ass']) {
        const b = document.createElement('button');
        b.textContent = `↓ .${fmt}`;
        b.style.cssText = 'cursor:pointer;';
        b.onclick = () => download(item, fmt);
        btns.appendChild(b);
      }
      row.append(title, info, btns);
      list.appendChild(row);
    }
  }

  document.addEventListener('DOMContentLoaded', () => { scanTracks(); render(); });
  setInterval(scanTracks, 2000);

  if (typeof GM_registerMenuCommand !== 'undefined') {
    GM_registerMenuCommand('Abrir/cerrar panel de subtítulos', () => {
      manualOpen = !manualOpen;
      render();
      if (manualOpen && list) list.style.display = 'block';
    });
  }
})();
