/**
 * Pipeline de transmissão: captura → codifica → envia.
 *
 * Módulo compartilhado entre a Activity (captura dentro do modal, quando o
 * Discord permite) e a página de captura externa (quando não permite). Uma
 * implementação só — duas cópias divergiriam na primeira correção.
 *
 * Sem WebRTC porque a Activity não tem, e sem MediaRecorder porque o container
 * impõe piso de latência. WebCodecs codifica quadro a quadro e envia direto.
 */

import { createAdaptive, codecLabel, AUTO_BITRATE, AUTO_FPS } from './adaptive.js';

export { AUTO_BITRATE, AUTO_FPS, codecLabel };

const HW = { hardwareAcceleration: 'prefer-hardware' };

// High/Main 4.2+ com encoder por hardware primeiro: Baseline 3.0 (42E01E) mal
// cobre 480p30 na spec e era o teto silencioso dos 60 fps. AV1/VP9 HW entram
// se o aparelho tiver; VP8 e Baseline ficam no fim, para o adaptativo descer
// resolução em vez de fingir 60 fps em software.
const CANDIDATES = [
  { codec: 'avc1.640033', avc: { format: 'annexb' }, ...HW },
  { codec: 'avc1.64002A', avc: { format: 'annexb' }, ...HW },
  { codec: 'avc1.4D402A', avc: { format: 'annexb' }, ...HW },
  { codec: 'av01.0.08M.08', ...HW },
  { codec: 'vp09.00.51.08', ...HW },
  { codec: 'avc1.64002A', avc: { format: 'annexb' } },
  { codec: 'avc1.42E02A', avc: { format: 'annexb' }, ...HW },
  { codec: 'avc1.42E01E', avc: { format: 'annexb' } },
  { codec: 'avc1.42E01E' },
  { codec: 'vp8' },
];

// Keyframe periódico: seguro barato para quem reconecta fora do fluxo normal.
const KEYFRAME_EVERY_MS = 3000;

// Tipos do primeiro byte útil de cada pacote. O áudio anda pelo mesmo socket e
// pelo mesmo cabeçalho do vídeo: um canal só, um formato só, e o servidor
// continua repassando o buffer sem precisar abrir nada.
const TIPO_KEYFRAME = 1;
const TIPO_DELTA = 2;
const TIPO_AUDIO = 3;

// 96 kbps em Opus estéreo é transparente para som de aplicativo e de vídeo, e é
// ruído perto dos megabits do vídeo — não vale economizar aqui.
const AUDIO_BITRATE = 96_000;

const even = (n) => Math.max(2, n - (n % 2));

function fitWithin(w, h, maxW, maxH) {
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: even(Math.round(w * scale)), height: even(Math.round(h * scale)) };
}

function hintForFps(n) {
  return n >= 60 ? 'motion' : 'text';
}

/** Motivo pelo qual este navegador não consegue transmitir, ou null. */
export function supportError({ requireChromium = false } = {}) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return 'Este navegador não permite captura de tela. Navegador de celular não suporta captura — use um desktop.';
  }
  if (!window.VideoEncoder || !window.VideoFrame || !window.EncodedVideoChunk) {
    return 'Este navegador não tem WebCodecs, necessário para transmitir. Use Chrome, Edge ou outro navegador Chromium no desktop.';
  }
  // Exigência de produto, não de capacidade: o caminho via <video> funciona em
  // Firefox e Safari, mas a captura sai visivelmente pior.
  if (requireChromium && !window.MediaStreamTrackProcessor) {
    return 'Transmitir exige um navegador Chromium — Chrome, Edge, Brave ou Opera. Nos outros a captura fica com qualidade ruim, então está desabilitada. Você continua podendo assistir.';
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.wsUrl        endpoint do relay, com o token de transmissor
 * @param {number} opts.bitrate      bits por segundo (teto inicial)
 * @param {number} opts.fps
 * @param {boolean} [opts.adaptive]  ajusta bitrate/resolução/fps sozinho
 * @param {number} [opts.maxFps]     teto do modo automático (60–120)
 * @param {boolean} [opts.audio]     capturar também o som do computador
 * @param {(info:object)=>void} [opts.onStatus]  codec/resolução/caminho de captura
 * @param {(stats:object)=>void} [opts.onStats]  viewers, fps, mbps, segundos no ar
 * @param {(reason:string)=>void} [opts.onEnd]   encerrou (por qualquer motivo)
 * @param {(msg:string)=>void} [opts.onAviso]    algo mudou sem ser erro
 * @param {(msg:string)=>void} [opts.onError]
 */
export function createBroadcaster({
  wsUrl,
  bitrate,
  fps,
  adaptive = false,
  maxFps = 120,
  audio = false,
  onStatus,
  onStats,
  onEnd,
  onError,
  onAviso,
}) {
  let ws = null;
  let stream = null;
  let encoder = null;
  let reader = null;
  let audioEncoder = null;
  let audioReader = null;
  // Pediram som, mas a superfície escolhida traria o Discord junto. Guardado
  // para a interface poder oferecer a saída em vez de só avisar e esquecer.
  let somBloqueado = false;
  let video = null;
  let config = null;
  let stage = null;
  let stageCtx = null;

  let running = false;
  let mySlot = 0;
  let wantKeyframe = true;
  let lastKeyframeAt = 0;
  let srcW = 0;
  let srcH = 0;
  let startedAt = 0;
  let bytes = 0;
  let frames = 0;
  let viewers = 0;
  let statsTimer = null;
  let maxW = 1920;
  let maxH = 1080;
  let hardware = false;
  let softwareAvisado = false;
  const adapt = createAdaptive({
    enabled: adaptive,
    bitrate,
    fps,
    maxFps,
    maxHeight: maxH,
  });

  function videoCaptureOptions() {
    // Chrome costuma entregar 30 fps se o teto for o próprio alvo. Com 60+
    // pedimos até 120 para o adaptativo ter de onde subir, e repetimos o
    // pedido em applyConstraints — o primeiro frequentemente é ignorado.
    const max = fps >= 60 ? 120 : fps;
    return {
      frameRate: { ideal: fps, max },
      width: { max: 1920 },
      height: { max: 1080 },
    };
  }

  function applyCaptureRate(track) {
    if (!track) return;
    track.contentHint = hintForFps(fps);
    const max = fps >= 60 ? 120 : fps;
    track.applyConstraints({ frameRate: { ideal: fps, max } }).catch(() => {});
  }

  function emitStatus(extra = {}) {
    if (!config) return;
    onStatus?.({
      codec: config.codec,
      label: codecLabel(config.codec, hardware),
      width: config.width,
      height: config.height,
      bitrate,
      fps,
      hardware,
      adaptive: adapt.isEnabled(),
      direct: Boolean(window.MediaStreamTrackProcessor),
      ...extra,
    });
  }

  async function start() {
    // Precisa vir do gesto do usuário; qualquer await antes disso o invalida.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoCaptureOptions(),
      // systemAudio: 'include' pede o som do computador em vez de só o da aba.
      // Os tratamentos de voz ficam desligados: eles existem para microfone e,
      // em som de aplicativo, cortam justamente o que se queria ouvir.
      audio: audio ? audioConstraints() : false,
    });

    const track = stream.getVideoTracks()[0];
    // 60+ fps pede 'motion' (jogo/vídeo). Abaixo disso, 'text' preserva UI.
    track.contentHint = hintForFps(fps);
    track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));
    applyCaptureRate(track);

    const s = track.getSettings();
    const target = fitWithin(s.width ?? 1280, s.height ?? 720, maxW, maxH);

    config = await pickConfig(target.width, target.height);
    if (!config) {
      cleanup();
      throw new Error('Nenhum codec de vídeo suportado por este navegador.');
    }

    await connect();

    encoder = new VideoEncoder({
      output: onEncoded,
      error: (err) => stop(`Erro no encoder: ${err.message}`),
    });
    encoder.configure(config);

    hardware = config.hardwareAcceleration === 'prefer-hardware';

    ws.send(JSON.stringify({ type: 'start' }));

    running = true;
    wantKeyframe = true;
    lastKeyframeAt = 0;
    srcW = 0;
    srcH = 0;
    startedAt = Date.now();
    softwareAvisado = false;

    emitStatus();

    statsTimer = setInterval(() => {
      const actualFps = frames;
      const decision = adapt.tick({
        fps: actualFps,
        targetFps: fps,
        queueSize: encoder?.encodeQueueSize ?? 0,
        bufferedAmount: ws?.bufferedAmount ?? 0,
        hardware,
      });
      if (decision) applyAdaptive(decision);

      onStats?.({
        viewers,
        fps: actualFps,
        mbps: (bytes * 8) / 1e6,
        seconds: Math.floor((Date.now() - startedAt) / 1000),
        width: config?.width,
        height: config?.height,
        bitrate,
        targetFps: fps,
        hardware,
        codec: config?.codec,
        label: config ? codecLabel(config.codec, hardware) : '',
        adaptive: adapt.isEnabled(),
        reason: adapt.snapshot().reason,
      });
      bytes = 0;
      frames = 0;
    }, 1000);

    pump(track);
    // Pedir áudio não garante receber: em vários sistemas a caixa "compartilhar
    // o som" fica desmarcada, e o navegador devolve a tela sem faixa de som.
    const audioTrack = prepararSom(track, stream);
    if (audioTrack) pumpAudio(audioTrack);

    return stream;
  }

  /**
   * Restrições da captura de som.
   *
   * Os tratamentos de voz ficam desligados: existem para microfone e, em som de
   * aplicativo, cortam justamente o que se queria ouvir.
   *
   * restrictOwnAudio tira da captura o que esta própria página está tocando —
   * sem ele, quem transmite enquanto assiste a outra tela devolveria o som dela
   * de volta para a sala, em laço. É experimental, então vai sob detecção.
   */
  function audioConstraints() {
    const c = {
      systemAudio: 'include',
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    if (navigator.mediaDevices.getSupportedConstraints?.().restrictOwnAudio) {
      c.restrictOwnAudio = true;
    }
    return c;
  }

/**
   * Devolve a faixa de som, ou null quando ela traria a call de volta em eco.
   *
   * O nó: o som do sistema é capturado como uma mistura única, e nenhum
   * navegador expõe um jeito de tirar um processo dela. O Windows tem essa API
   * (é assim que o Discord nativo compartilha som sem se ouvir), mas página web
   * não alcança. Então "som da tela inteira" é sempre "som do sistema INTEIRO",
   * com a saída do Discord dentro — e a call inteira se escuta, com atraso.
   *
   * Aba é diferente: o som sai só daquela aba, e o Discord nunca entra.
   *
   * Por isso a mistura do sistema é recusada aqui, antes de sair da máquina. O
   * que evita a versão anterior disto virar um beco sem saída é `trocarSom()`:
   * dá para manter o vídeo da tela inteira e pegar o som de uma aba.
   */
  function prepararSom(videoTrack, capturado) {
    const faixa = capturado.getAudioTracks()[0];
    if (!faixa) return null;

    if (videoTrack.getSettings?.().displaySurface === 'browser') return faixa;

    faixa.stop();
    capturado.removeTrack(faixa);
    somBloqueado = true;
    onAviso?.(
      'A tela inteira carrega o som do Discord junto, e a call se ouviria em eco. ' +
        'Transmitindo sem som — use "Som de uma aba" para escolher de onde vem o áudio.'
    );
    return null;
  }

  /**
   * Troca só a fonte do som, sem tocar no vídeo.
   *
   * É o que torna som e tela inteira compatíveis: o vídeo continua sendo a tela
   * escolhida e o som passa a vir de uma aba, que é isolada por construção. A
   * segunda janela de escolha é o preço, e é um preço honesto — não há como o
   * navegador adivinhar de qual aplicativo o som deveria vir.
   */
  async function trocarSom() {
    // Precisa vir do gesto do usuário, como qualquer getDisplayMedia.
    const escolha = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: audioConstraints(),
    });

    const faixa = escolha.getAudioTracks()[0];
    const superficie = escolha.getVideoTracks()[0]?.getSettings?.().displaySurface;

    // O vídeo desta escolha não interessa: viemos só pelo som.
    escolha.getVideoTracks().forEach((t) => t.stop());

    if (!faixa) {
      escolha.getTracks().forEach((t) => t.stop());
      throw new Error(
        'Essa escolha veio sem som. Escolha uma aba e marque "Compartilhar o áudio da guia".'
      );
    }

    if (superficie !== 'browser') {
      faixa.stop();
      throw new Error(
        'Só aba tem som isolado. Tela inteira traria o Discord junto e a call se ouviria.'
      );
    }

    // Encerra o laço anterior antes de abrir outro, senão os dois alimentam o
    // mesmo encoder e a fila estoura.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    if (audioEncoder?.state === 'configured') {
      try {
        audioEncoder.close();
      } catch {}
    }
    audioEncoder = null;

    somBloqueado = false;
    faixa.addEventListener('ended', () => onAviso?.('A aba do som foi fechada.'));
    pumpAudio(faixa);
    return faixa;
  }

  // -------------------------------------------------------------------- áudio

  /**
   * Captura, codifica e envia o som.
   *
   * O AudioEncoder recebe os blocos no tamanho que o sistema entregar e devolve
   * pacotes Opus de 20 ms — não é preciso reagrupar nada por fora. Cada pacote
   * se decodifica sozinho, então não existe aqui o equivalente ao keyframe.
   */
  async function pumpAudio(track) {
    if (!window.AudioEncoder || !window.MediaStreamTrackProcessor) return;

    const s = track.getSettings();
    const sampleRate = s.sampleRate || 48_000;
    const numberOfChannels = Math.min(2, s.channelCount || 2);

    try {
      audioEncoder = new AudioEncoder({
        output: onAudioEncoded,
        // Som é acessório: se o encoder cair, a tela continua no ar.
        error: (err) => console.warn('[audio encoder]', err.message),
      });
      audioEncoder.configure({ codec: 'opus', sampleRate, numberOfChannels, bitrate: AUDIO_BITRATE });
    } catch (err) {
      console.warn('[audio encoder]', err.message);
      audioEncoder = null;
      return;
    }

    // O mesmo caminho do vídeo: quem chega depois recebe isto ao pedir a tela.
    ws?.send(
      JSON.stringify({ type: 'audio-config', config: { codec: 'opus', sampleRate, numberOfChannels } })
    );

    audioReader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    while (running) {
      let dados;
      try {
        const { done, value } = await audioReader.read();
        if (done) break;
        dados = value;
      } catch {
        break;
      }

      if (audioEncoder?.state === 'configured') {
        try {
          audioEncoder.encode(dados);
        } catch (err) {
          console.warn('[audio encode]', err.message);
        }
      }
      dados.close();
    }
  }

  function onAudioEncoded(chunk) {
    if (ws?.readyState !== WebSocket.OPEN) return;

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    ws.send(empacotar(TIPO_AUDIO, chunk.timestamp ?? 0, data));
    bytes += 18 + data.byteLength;
  }

  async function pickConfig(width, height) {
    // Várias passadas: `latencyMode`, `bitrateMode` e `hardwareAcceleration`
    // são recusados em bloco em navegadores antigos. Mais latência é melhor
    // que nada; software é melhor que recusar a transmissão.
    const extras = [
      { latencyMode: 'realtime', bitrateMode: 'variable' },
      { latencyMode: 'realtime' },
      { bitrateMode: 'variable' },
      {},
    ];
    for (const extra of extras) {
      for (const candidate of CANDIDATES) {
        const cfg = { ...candidate, width, height, bitrate, framerate: fps, ...extra };
        try {
          const { supported } = await VideoEncoder.isConfigSupported(cfg);
          if (supported) return cfg;
        } catch {
          // candidato inválido neste navegador; tenta o próximo
        }
      }
    }
    return null;
  }

  function applyAdaptive(decision) {
    if (decision.bitrate) bitrate = decision.bitrate;
    if (decision.fps) fps = decision.fps;
    if (decision.maxHeight) {
      maxH = decision.maxHeight;
      maxW = even(Math.round(decision.maxHeight * (16 / 9)));
      srcW = 0;
      srcH = 0;
    }

    if (encoder?.state === 'configured') {
      config = { ...config, bitrate, framerate: fps };
      try {
        encoder.configure(config);
      } catch (err) {
        console.warn('[adapt configure]', err.message);
      }
      wantKeyframe = true;
    }

    applyCaptureRate(stream?.getVideoTracks()[0]);
    emitStatus({ reason: decision.reason });

    if (decision.reason === 'software' && !softwareAvisado) {
      softwareAvisado = true;
      onAviso?.(
        'Este computador está codificando por software e não segura 60 fps em tela grande. ' +
          'Caindo para 30 fps para a imagem ficar estável.'
      );
    }
  }

  // ------------------------------------------------------------------ captura

  function pump(track) {
    if (window.MediaStreamTrackProcessor) pumpDirect(track);
    else pumpViaVideo();
  }

  /** Chromium: acesso direto aos quadros, sem cópia intermediária. */
  async function pumpDirect(track) {
    reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    while (running) {
      let frame;
      try {
        const { done, value } = await reader.read();
        if (done) break;
        frame = value;
      } catch {
        break;
      }
      if (!encodeFrame(frame)) break;
    }
  }

  /** Demais navegadores: extrai os quadros de um <video> alimentado pela stream. */
  function pumpViaVideo() {
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    // Fora do fluxo mas no DOM: alguns navegadores não decodificam um elemento
    // solto, e display:none chega a pausar a reprodução.
    Object.assign(video.style, {
      position: 'fixed',
      left: '-9999px',
      width: '2px',
      height: '2px',
      opacity: '0',
    });
    document.body.append(video);
    video.play().catch(() => {});

    const t0 = performance.now();
    const hasRvfc = typeof video.requestVideoFrameCallback === 'function';
    const minGap = 1000 / (fps + 2);
    let lastAt = 0;

    const schedule = () => {
      if (!running) return;
      if (hasRvfc) video.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };

    const tick = () => {
      if (!running) return;
      // Alguns navegadores pausam ao trocar de aba; sem isso o loop morre em
      // silêncio e a transmissão congela sem erro nenhum.
      if (video.paused) video.play().catch(() => {});
      if (video.readyState < 2 || !video.videoWidth) return schedule();

      const now = performance.now();
      // rAF segue o refresh da tela, que pode ser bem acima do fps alvo.
      if (!hasRvfc && now - lastAt < minGap) return schedule();
      lastAt = now;

      let frame;
      try {
        frame = new VideoFrame(video, { timestamp: (now - t0) * 1000 });
      } catch {
        return schedule();
      }
      encodeFrame(frame);
      schedule();
    };

    schedule();
  }

  function encodeFrame(frame) {
    if (!running || encoder?.state !== 'configured') {
      frame.close();
      return false;
    }
    // Backpressure: fila no encoder vira latência que nunca mais sai.
    if (encoder.encodeQueueSize > 2) {
      frame.close();
      return true;
    }

    const timestamp = frame.timestamp ?? performance.now() * 1000;
    syncSize(frame);

    const now = Date.now();
    if (now - lastKeyframeAt > KEYFRAME_EVERY_MS) wantKeyframe = true;

    let out = frame;
    if (stage) {
      stageCtx.drawImage(frame, 0, 0, stage.width, stage.height);
      frame.close();
      out = new VideoFrame(stage, { timestamp });
    }

    try {
      encoder.encode(out, { keyFrame: wantKeyframe });
      if (wantKeyframe) {
        lastKeyframeAt = now;
        wantKeyframe = false;
      }
    } catch (err) {
      console.error('[encode]', err);
    }

    out.close();
    frames++;
    return true;
  }

  /**
   * Mantém o encoder casado com o tamanho real da fonte.
   *
   * displayWidth/Height e não codedWidth/Height: o codificado inclui padding de
   * alinhamento do codec, e configurar o encoder por ele faz recortar as bordas.
   */
  function syncSize(frame) {
    const sw = frame.displayWidth;
    const sh = frame.displayHeight;
    if (!sw || !sh || (sw === srcW && sh === srcH)) return;

    srcW = sw;
    srcH = sh;
    const target = fitWithin(sw, sh, maxW, maxH);

    if (target.width !== config.width || target.height !== config.height) {
      config = { ...config, ...target };
      encoder.configure(config);
      wantKeyframe = true;
      emitStatus();
    }

    // fitWithin preserva a proporção, então reduzir não corta nada.
    if (target.width === sw && target.height === sh) {
      stage = null;
      stageCtx = null;
    } else {
      stage = document.createElement('canvas');
      stage.width = target.width;
      stage.height = target.height;
      stageCtx = stage.getContext('2d', { alpha: false, desynchronized: true });
    }
  }

  function onEncoded(chunk, metadata) {
    if (ws?.readyState !== WebSocket.OPEN) return;

    // O decoderConfig chega no primeiro chunk e sempre que a config muda.
    if (metadata?.decoderConfig) {
      ws.send(JSON.stringify({ type: 'config', config: serializeConfig(metadata.decoderConfig) }));
    }

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);

    const buf = empacotar(
      chunk.type === 'key' ? TIPO_KEYFRAME : TIPO_DELTA,
      chunk.timestamp ?? 0,
      data
    );
    ws.send(buf);
    bytes += buf.byteLength;
  }

  /**
   * [1B slot][1B tipo][8B timestamp][8B relógio de envio][payload]
   *
   * O slot vem carimbado na origem para o servidor repassar o buffer intacto, e
   * o relógio de envio é o que permite medir o atraso do outro lado. Áudio e
   * vídeo compartilham o formato: o tipo é a única coisa que os distingue.
   */
  function empacotar(tipo, timestamp, data) {
    const buf = new ArrayBuffer(18 + data.byteLength);
    const view = new DataView(buf);
    view.setUint8(0, mySlot);
    view.setUint8(1, tipo);
    view.setFloat64(2, timestamp);
    view.setFloat64(10, Date.now());
    new Uint8Array(buf, 18).set(data);
    return buf;
  }

  function serializeConfig(dc) {
    const out = { codec: dc.codec, codedWidth: dc.codedWidth, codedHeight: dc.codedHeight };
    if (dc.description) {
      const b = new Uint8Array(
        dc.description instanceof ArrayBuffer ? dc.description : dc.description.buffer
      );
      let bin = '';
      for (const x of b) bin += String.fromCharCode(x);
      out.description = btoa(bin);
    }
    return out;
  }

  // ---------------------------------------------------------------- websocket

  function connect() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Não foi possível falar com o servidor (timeout).'));
      }, 10_000);

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      });

      ws.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') return;
        const msg = JSON.parse(e.data);

        if (msg.type === 'slot') mySlot = msg.slot;
        else if (msg.type === 'state') viewers = msg.viewers;
        // Alguém entrou na sala e precisa de um ponto de partida.
        else if (msg.type === 'need-keyframe') wantKeyframe = true;
        else if (msg.type === 'stop-request') stop('Transmissão encerrada pela atividade.');
        else if (msg.type === 'error') {
          if (running) stop(msg.message);
          else {
            clearTimeout(timeout);
            reject(new Error(msg.message));
          }
        }
      });

      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Falha ao conectar no servidor.'));
      });

      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        if (running) stop('Conexão com o servidor caiu.');
      });
    });
  }

  // -------------------------------------------------------------------- parar

  // ------------------------------------------------------------ ao vivo

  /**
   * Troca a tela compartilhada sem derrubar a transmissão.
   *
   * A conexão, o encoder e o slot continuam os mesmos — quem assiste só vê a
   * imagem mudar, sem piscar nem reconectar.
   */
  async function changeScreen() {
    // Precisa vir do gesto do usuário, como qualquer getDisplayMedia.
    const fresh = await navigator.mediaDevices.getDisplayMedia({
      video: videoCaptureOptions(),
      audio: audio ? audioConstraints() : false,
    });

    const previous = stream;
    const previousReader = reader;

    stream = fresh;
    const track = fresh.getVideoTracks()[0];
    track.contentHint = hintForFps(fps);
    track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));
    applyCaptureRate(track);

    // Encerra o loop anterior antes de abrir outro, senão os dois disputam o
    // encoder e a fila estoura.
    reader = null;
    await previousReader?.cancel().catch(() => {});
    previous?.getTracks().forEach((t) => t.stop());

    // Zera o tamanho conhecido: a tela nova quase certamente tem outro, e é o
    // syncSize que reconfigura o encoder.
    srcW = 0;
    srcH = 0;
    wantKeyframe = true;

    if (video) {
      video.srcObject = fresh;
      video.play().catch(() => {});
    } else {
      pumpDirect(track);
    }

    // A tela nova traz a própria faixa de som; a antiga morreu com o stream.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    const novoAudio = prepararSom(track, fresh);
    if (novoAudio && audioEncoder) pumpAudio(novoAudio);

    return fresh;
  }

  /** Ajusta qualidade e taxa de quadros com a transmissão no ar. */
  function setQuality({ bitrate: nextBitrate, fps: nextFps, adaptive: nextAdaptive } = {}) {
    if (nextAdaptive != null) adapt.setEnabled(nextAdaptive);
    if (nextBitrate) bitrate = nextBitrate;
    if (nextFps) fps = nextFps;
    adapt.setManual({ bitrate, fps, maxHeight: maxH });
    if (encoder?.state !== 'configured') return;

    config = { ...config, bitrate, framerate: fps };
    encoder.configure(config);
    wantKeyframe = true;
    applyCaptureRate(stream?.getVideoTracks()[0]);
    emitStatus();
  }

  const getSettings = () => ({ bitrate, fps, adaptive: adapt.isEnabled() });

  function cleanup() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video?.remove();
    video = null;
    stage = null;
    stageCtx = null;
  }

  function stop(reason) {
    const wasRunning = running;
    running = false;

    clearInterval(statsTimer);
    statsTimer = null;

    reader?.cancel().catch(() => {});
    reader = null;
    audioReader?.cancel().catch(() => {});
    audioReader = null;

    for (const e of [encoder, audioEncoder]) {
      if (e?.state === 'configured') {
        try {
          e.close();
        } catch {}
      }
    }
    encoder = null;
    audioEncoder = null;

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
      ws.close();
    }
    ws = null;

    cleanup();
    if (wasRunning) onEnd?.(reason ?? '');
  }

  return {
    start,
    stop,
    changeScreen,
    trocarSom,
    setQuality,
    getSettings,
    temSom: () => Boolean(audioEncoder),
    somBloqueado: () => somBloqueado,
    isRunning: () => running,
  };
}
