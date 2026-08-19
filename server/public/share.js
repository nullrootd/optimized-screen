/**
 * Página de captura externa.
 *
 * Só existe como alternativa: quando o Discord não concede `display-capture` ao
 * iframe da Activity, a transmissão precisa nascer numa página top-level, onde
 * getDisplayMedia funciona sem restrição.
 *
 * Toda a lógica de captura e codificação vive em /shared/broadcaster.js, a mesma
 * usada dentro da Activity — aqui é só a interface.
 */
import { createBroadcaster, supportError, AUTO_BITRATE, AUTO_FPS } from '/shared/broadcaster.js?v=5';

const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(location.search);
const token = query.get('t');

let broadcaster = null;

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

function fail(title, msg) {
  $('roomLine').textContent = title;
  $('setup').hidden = true;
  setStatus(msg, 'error');
}

function readTokenPayload() {
  try {
    return JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

function qualityFromUi() {
  const auto = $('quality').value === 'auto';
  const fps = Number($('fps').value) || AUTO_FPS;
  if (auto) {
    return { adaptive: true, bitrate: AUTO_BITRATE, fps: AUTO_FPS, maxFps: fps < 60 ? 60 : fps };
  }
  return { adaptive: false, bitrate: Number($('quality').value), fps, maxFps: fps };
}

function rotuloPreset() {
  const q = qualityFromUi();
  const comSom = $('withAudio').checked ? ' · com som' : '';
  if (q.adaptive) return `Automático · 60+ fps${comSom}`;
  const mbps = (q.bitrate / 1e6).toFixed(1).replace('.', ',');
  return `${mbps} Mb/s · ${q.fps} fps${comSom}`;
}

// ------------------------------------------------------------------ arranque

const payload = token && readTokenPayload();
const missing = supportError({ requireChromium: true });

if (!payload) {
  fail('Link inválido.', 'Volte à atividade no Discord e clique em compartilhar novamente.');
} else if (payload.exp && payload.exp * 1000 < Date.now()) {
  fail('Link expirado.', 'Gere um novo pela atividade.');
} else if (missing) {
  fail('Navegador sem suporte.', missing);
} else {
  $('roomLine').textContent = `Transmitindo como ${payload.name}`;
  applyPresets();
  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', () => broadcaster?.stop('Transmissão encerrada.'));
  $('advanced').addEventListener('click', () => {
    const rows = document.querySelectorAll('#setup .row');
    const hide = ![...rows].some((r) => r.hidden);
    for (const row of rows) row.hidden = hide;
    $('advanced').textContent = hide ? 'Ajustes avançados' : 'Ocultar ajustes';
    $('presetLine').textContent = rotuloPreset();
  });
  $('quality').addEventListener('change', () => {
    $('presetLine').textContent = rotuloPreset();
  });
  $('fps').addEventListener('change', () => {
    $('presetLine').textContent = rotuloPreset();
  });
}

function applyPresets() {
  const q = query.get('q');
  const fps = query.get('fps');
  const som = query.get('som');

  if (som !== null) {
    $('withAudio').checked = som === '1';
    document.querySelector('.check').hidden = true;
  }

  for (const row of document.querySelectorAll('#setup .row')) row.hidden = true;

  if (q) {
    $('quality').value = q;
    if ($('quality').value !== q) $('quality').value = 'auto';
  }
  if (fps) $('fps').value = fps;

  $('presetLine').textContent = rotuloPreset();
  $('presetLine').hidden = false;
}

async function start() {
  $('start').disabled = true;
  setStatus('Aguardando você escolher a tela…');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = qualityFromUi();

  broadcaster = createBroadcaster({
    wsUrl: `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}`,
    bitrate: q.bitrate,
    fps: q.fps,
    adaptive: q.adaptive,
    maxFps: q.maxFps,
    audio: $('withAudio').checked,
    onStatus: (s) => {
      const hw = s.hardware ? 'HW' : 'SW';
      setStatus(
        `${s.label || s.codec} · ${s.width}×${s.height} · captura ${s.direct ? 'direta' : 'via <video>'} · ${hw}`
      );
      if (s.reason) {
        $('hud').textContent =
          `${s.fps} fps · ${s.width}×${s.height} · ${(s.bitrate / 1e6).toFixed(1)} Mb/s · ${s.label}`;
      }
    },
    onStats: (s) => {
      $('viewers').textContent = s.viewers;
      $('fpsOut').textContent = `${s.fps} fps`;
      $('bitrate').textContent = `${s.mbps.toFixed(1)} Mb/s`;
      $('elapsed').textContent =
        `${String(Math.floor(s.seconds / 60)).padStart(2, '0')}:${String(s.seconds % 60).padStart(2, '0')}`;
      const res = s.width && s.height ? `${s.width}×${s.height}` : '—';
      $('hud').textContent = `${s.fps} fps · ${res} · ${s.mbps.toFixed(1)} Mb/s · ${s.label || ''}`.trim();
    },
    onAviso: (msg) => {
      setStatus(msg, 'aviso');
      $('somAba').hidden = false;
    },
    onEnd: (reason) => {
      broadcaster = null;
      $('preview').srcObject = null;
      $('live').hidden = true;
      $('setup').hidden = false;
      $('start').disabled = false;
      setStatus(reason);
    },
  });

  try {
    const stream = await broadcaster.start();
    $('preview').srcObject = stream;
    $('preview').play().catch(() => {});
    $('setup').hidden = true;
    $('live').hidden = false;
  } catch (err) {
    broadcaster = null;
    $('start').disabled = false;
    setStatus(
      err.name === 'NotAllowedError' ? 'Você cancelou a seleção de tela.' : err.message,
      'error'
    );
  }
}

$('somAba').addEventListener('click', async () => {
  if (!broadcaster) return;
  try {
    await broadcaster.trocarSom();
    setStatus('Som ligado, vindo da aba escolhida.', 'ok');
    $('somAba').textContent = 'Trocar a aba do som';
  } catch (err) {
    if (err.name !== 'NotAllowedError') setStatus(err.message, 'error');
  }
});

window.addEventListener('beforeunload', () => broadcaster?.stop());
