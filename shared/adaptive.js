/**
 * Controle de qualidade em tempo real.
 *
 * Prioridade: manter ≥ 60 fps. Resolução e bitrate sobem ou descem em volta
 * disso. FPS só cai para 30 quando o encoder (quase sempre software) não
 * segura 720p60 — melhor 30 estáveis do que 60 no papel e 35 na tela.
 *
 * Três sinais, um por segundo:
 *   - fila do encoder / fps real  → CPU/GPU
 *   - bufferedAmount do WebSocket → rede
 *   - folga contínua              → sobe um degrau
 */

export const AUTO_BITRATE = 10_000_000;
export const AUTO_FPS = 60;

export const HEIGHT_LADDER = [720, 900, 1080];
export const BITRATE_LADDER = [3_000_000, 6_000_000, 10_000_000, 16_000_000];
export const FPS_LADDER = [30, 60, 90, 120];

const QUEUE_BUSY = 2;
const NETWORK_BUSY = 512 * 1024;
const BAD_BEFORE_DROP = 2;
const GOOD_BEFORE_RAISE = 3;

export function codecLabel(codec, hardware) {
  const nome = codec?.startsWith('avc1')
    ? 'H264'
    : codec?.startsWith('av01')
      ? 'AV1'
      : codec?.startsWith('vp09')
        ? 'VP9'
        : codec?.startsWith('vp8')
          ? 'VP8'
          : codec ?? '—';
  return hardware ? `${nome} HW` : `${nome} SW`;
}

export function createAdaptive({
  enabled = true,
  bitrate = AUTO_BITRATE,
  fps = AUTO_FPS,
  maxFps = 120,
  maxHeight = 1080,
} = {}) {
  let on = enabled;
  let height = clampTo(HEIGHT_LADDER, maxHeight);
  let bitrateIdx = nearestIndex(BITRATE_LADDER, bitrate);
  let fpsIdx = nearestIndex(FPS_LADDER, fps);
  const tetoFpsIdx = nearestIndex(FPS_LADDER, maxFps);
  let bad = 0;
  let good = 0;
  let lastReason = '';

  function tick({
    fps: actualFps,
    targetFps,
    queueSize,
    bufferedAmount,
    hardware = true,
  } = {}) {
    if (!on) return null;

    const overload = queueSize > QUEUE_BUSY || actualFps < targetFps * 0.7;
    const network = bufferedAmount > NETWORK_BUSY;

    if (overload || network) {
      good = 0;
      bad++;
      if (bad < BAD_BEFORE_DROP) return null;
      bad = 0;

      if (network && bitrateIdx > 0) {
        bitrateIdx--;
        lastReason = 'rede';
        return { bitrate: BITRATE_LADDER[bitrateIdx], reason: lastReason };
      }

      if (overload) {
        const hi = HEIGHT_LADDER.indexOf(height);
        if (hi > 0) {
          height = HEIGHT_LADDER[hi - 1];
          lastReason = 'encoder';
          return { maxHeight: height, reason: lastReason };
        }

        if (FPS_LADDER[fpsIdx] > 60) {
          fpsIdx = nearestIndex(FPS_LADDER, 60);
          lastReason = 'encoder';
          return { fps: FPS_LADDER[fpsIdx], reason: lastReason };
        }

        if (bitrateIdx > 0) {
          bitrateIdx--;
          lastReason = 'encoder';
          return { bitrate: BITRATE_LADDER[bitrateIdx], reason: lastReason };
        }

        if (FPS_LADDER[fpsIdx] > 30) {
          fpsIdx = 0;
          lastReason = hardware ? 'encoder' : 'software';
          return { fps: 30, reason: lastReason };
        }
      }

      if (bitrateIdx > 0) {
        bitrateIdx--;
        lastReason = network ? 'rede' : 'encoder';
        return { bitrate: BITRATE_LADDER[bitrateIdx], reason: lastReason };
      }

      return null;
    }

    bad = 0;
    good++;
    if (good < GOOD_BEFORE_RAISE) return null;
    good = 0;

    if (bitrateIdx < BITRATE_LADDER.length - 1) {
      bitrateIdx++;
      lastReason = 'folga';
      return { bitrate: BITRATE_LADDER[bitrateIdx], reason: lastReason };
    }

    const hi = HEIGHT_LADDER.indexOf(height);
    if (hi >= 0 && hi < HEIGHT_LADDER.length - 1) {
      height = HEIGHT_LADDER[hi + 1];
      lastReason = 'folga';
      return { maxHeight: height, reason: lastReason };
    }

    if (hardware && fpsIdx < tetoFpsIdx) {
      fpsIdx++;
      lastReason = 'folga';
      return { fps: FPS_LADDER[fpsIdx], reason: lastReason };
    }

    return null;
  }

  function setEnabled(next) {
    on = Boolean(next);
    bad = 0;
    good = 0;
  }

  function setManual({ bitrate: b, fps: f, maxHeight: h } = {}) {
    if (b) bitrateIdx = nearestIndex(BITRATE_LADDER, b);
    if (f) fpsIdx = nearestIndex(FPS_LADDER, f);
    if (h) height = clampTo(HEIGHT_LADDER, h);
    bad = 0;
    good = 0;
  }

  const snapshot = () => ({
    enabled: on,
    bitrate: BITRATE_LADDER[bitrateIdx],
    fps: FPS_LADDER[fpsIdx],
    maxHeight: height,
    reason: lastReason,
  });

  return { tick, setEnabled, setManual, snapshot, isEnabled: () => on };
}

function nearestIndex(ladder, value) {
  let best = 0;
  let dist = Infinity;
  for (let i = 0; i < ladder.length; i++) {
    const d = Math.abs(ladder[i] - value);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}

function clampTo(ladder, value) {
  return ladder[nearestIndex(ladder, value)];
}
