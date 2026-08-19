/**
 * Player WebCodecs.
 *
 * Dentro da Activity não existe WebRTC, mas WebCodecs não é bloqueado por
 * Permissions Policy — então dá para decodificar quadro a quadro sem container.
 *
 * Quando o navegador tem MediaStreamTrackGenerator, os quadros vão para um
 * <video>: o compositor nativo segura 60–120 fps melhor do que canvas 2D.
 * Sem isso, cai no canvas (buffer sempre no tamanho nativo, CSS só limita).
 */

export function createPlayer({ onError, onTamanho } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (ctx) ctx.imageSmoothingEnabled = false;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;

  const useGenerator = typeof MediaStreamTrackGenerator === 'function';
  canvas.className = 'stream-surface';
  video.className = 'stream-surface';
  let surface = useGenerator ? video : canvas;

  let decoder = null;
  let generator = null;
  let writer = null;
  let needKeyframe = true;
  let lastLagMs = 0;
  let framesDrawn = 0;
  let lastW = 0;
  let lastH = 0;
  // Quem espera precisa saber quando a espera acabou: entre pedir para assistir
  // e o primeiro quadro cabe um keyframe inteiro de atraso, e o quadro preto
  // desse intervalo é idêntico a um travamento.
  let virgem = true;

  function start(rawConfig) {
    stop();

    if (!window.VideoDecoder) {
      onError?.('Este navegador não tem WebCodecs — não é possível assistir.');
      return false;
    }

    const config = deserialize(rawConfig);

    decoder = new VideoDecoder({
      output: draw,
      error: (err) => {
        // Erro de decodificação normalmente é fluxo fora de sincronia:
        // pedir um keyframe recupera sem derrubar a sessão.
        console.warn('[decoder]', err.message);
        needKeyframe = true;
      },
    });

    try {
      decoder.configure(config);
    } catch {
      delete config.hardwareAcceleration;
      try {
        decoder.configure(config);
      } catch {
        onError?.(`Codec não suportado por este navegador: ${config.codec}`);
        decoder = null;
        return false;
      }
    }

    if (useGenerator) {
      try {
        generator = new MediaStreamTrackGenerator({ kind: 'video' });
        writer = generator.writable.getWriter();
        video.srcObject = new MediaStream([generator]);
        video.play().catch(() => {});
        surface = video;
      } catch (err) {
        console.warn('[track generator]', err.message);
        generator = null;
        writer = null;
        surface = canvas;
      }
    }

    needKeyframe = true;
    return true;
  }

  /** Quadro empacotado: [1B slot][1B tipo][8B timestamp][8B envio][payload] */
  function push(buffer) {
    if (!decoder || decoder.state !== 'configured') return;

    const view = new DataView(buffer);
    const isKeyframe = view.getUint8(1) === 1;

    // Decoder frio só aceita keyframe; deltas antes disso viram erro.
    if (needKeyframe && !isKeyframe) return;

    const timestamp = view.getFloat64(2);
    const sentAt = view.getFloat64(10);
    lastLagMs = Date.now() - sentAt;

    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: isKeyframe ? 'key' : 'delta',
          timestamp,
          data: new Uint8Array(buffer, 18),
        })
      );
      needKeyframe = false;
    } catch (err) {
      console.warn('[decode]', err.message);
      needKeyframe = true;
    }
  }

  function draw(frame) {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    const mudou = w !== lastW || h !== lastH;
    lastW = w;
    lastH = h;

    if (writer) {
      if (writer.desiredSize != null && writer.desiredSize <= 0) {
        frame.close();
      } else {
        writer.write(frame).catch(() => {
          try {
            frame.close();
          } catch {}
          cairNoCanvas();
        });
      }
    } else {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        ctx.imageSmoothingEnabled = false;
      }
      ctx.drawImage(frame, 0, 0, w, h);
      frame.close();
    }

    framesDrawn++;

    if (virgem || mudou) {
      virgem = false;
      onTamanho?.();
    }
  }

  function cairNoCanvas() {
    writer = null;
    generator = null;
    video.srcObject = null;
    if (surface === video) {
      video.replaceWith(canvas);
      surface = canvas;
    }
  }

  function stop() {
    if (decoder && decoder.state !== 'closed') {
      try {
        decoder.close();
      } catch {}
    }
    decoder = null;
    needKeyframe = true;
    lastLagMs = 0;
    virgem = true;

    writer?.close().catch(() => {});
    writer = null;
    generator = null;
    video.srcObject = null;

    if (canvas.width && canvas.height) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  /** Atraso aproximado em ms. Exato na mesma máquina; entre máquinas, sujeito a desvio de relógio. */
  const getLag = () => lastLagMs;

  function getNativeSize() {
    return { width: lastW, height: lastH };
  }

  /** Resolução nativa do vídeo e tamanho de exibição — para diagnóstico. */
  function getSizes() {
    const rect = surface.getBoundingClientRect();
    return {
      video: lastW && lastH ? `${lastW}×${lastH}` : '—',
      box: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
    };
  }

  function takeFrameCount() {
    const n = framesDrawn;
    framesDrawn = 0;
    return n;
  }

  return {
    get el() {
      return surface;
    },
    start,
    push,
    stop,
    getLag,
    takeFrameCount,
    getSizes,
    getNativeSize,
  };
}

function deserialize(c) {
  const out = {
    codec: c.codec,
    codedWidth: c.codedWidth,
    codedHeight: c.codedHeight,
    // Reduz o buffering interno do decoder — sem isso ele acumula alguns
    // quadros antes de emitir o primeiro.
    optimizeForLatency: true,
    hardwareAcceleration: 'prefer-hardware',
  };

  if (c.description) {
    const bin = atob(c.description);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    out.description = bytes;
  }

  return out;
}
