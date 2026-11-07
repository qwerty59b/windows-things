// ==UserScript==
// @name         YouTube: subtítulos en español automáticos
// @namespace    local.yt.subs.es
// @version      1.0
// @description  Si el audio del video no es español, activa subtítulos en español (reales si existen, si no traducidos automáticamente).
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-idle
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const TARGET = 'es';
  const MAX_TRIES = 40;      // 40 x 500ms = 20 s por video
  const INTERVAL = 500;

  let handledVideoId = null;
  let timer = null;

  const player = () => W.document.getElementById('movie_player');

  // Idioma hablado del video (heurística)
  function spokenLang(pr) {
    const r = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    const tracks = (r && r.captionTracks) || [];
    if (!tracks.length) return null;
    // Los subtítulos automáticos (asr) siempre están en el idioma del audio
    const asr = tracks.find(t => t.kind === 'asr');
    if (asr) return asr.languageCode;
    // Si no hay asr, el primer track manual suele ser el idioma original
    return tracks[0].languageCode;
  }

  const isSpanish = code => !!code && code.toLowerCase().startsWith(TARGET);

  function tryApply(videoId) {
    const p = player();
    if (!p || typeof p.getPlayerResponse !== 'function') return false;

    const pr = p.getPlayerResponse();
    if (!pr || !pr.videoDetails || pr.videoDetails.videoId !== videoId) return false;

    // Esperar a que termine un anuncio
    if (p.classList.contains('ad-showing')) return false;

    const lang = spokenLang(pr);
    if (!lang) return true;                 // sin subtítulos disponibles: nada que hacer
    if (isSpanish(lang)) return true;       // audio en español: no tocar

    // Cargar el módulo de subtítulos y leer la lista de tracks
    try { p.loadModule('captions'); } catch (e) {}
    const list = p.getOption('captions', 'tracklist') || [];
    if (!list.length) return false;         // aún no cargó, reintentar

    // 1) Subtítulo español real (preferir manual sobre automático)
    const esTracks = list.filter(t => isSpanish(t.languageCode));
    const esTrack = esTracks.find(t => t.kind !== 'asr') || esTracks[0];
    if (esTrack) {
      p.setOption('captions', 'track', esTrack);
      return true;
    }

    // 2) Traducción automática desde el track base
    const base = list.find(t => t.kind !== 'asr') || list[0];
    p.setOption('captions', 'track', Object.assign({}, base, {
      translationLanguage: { languageCode: TARGET }
    }));
    return true;
  }

  function start() {
    const m = W.location.pathname === '/watch' &&
      new URLSearchParams(W.location.search).get('v');
    if (!m || m === handledVideoId) return;
    handledVideoId = m;

    clearInterval(timer);
    let tries = 0;
    timer = setInterval(() => {
      tries++;
      let done = false;
      try { done = tryApply(m); } catch (e) { console.debug('[yt-subs-es]', e); }
      if (done || tries >= MAX_TRIES) clearInterval(timer);
    }, INTERVAL);
  }

  // YouTube es una SPA: reaccionar a la navegación interna
  W.document.addEventListener('yt-navigate-finish', start);
  W.document.addEventListener('yt-page-data-updated', start);
  start();
})();
