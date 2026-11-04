/**
 * Dictée en direct par Deepgram (WebSocket ouvert depuis le navigateur, clé en sous-protocole `token`).
 * Audio : MediaRecorder webm/opus, sinon (Safari) PCM 16 bits par AudioContext.
 */
import i18n from '@/i18n';

export type DictationState = 'idle' | 'connecting' | 'listening' | 'error';

export interface DictationHandlers {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onLevel?(level: number): void;
  onState(state: DictationState, error?: string): void;
}

const OPUS = 'audio/webm;codecs=opus';

function canRecordOpus(): boolean {
  return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(OPUS);
}

export function dictationSupported(): boolean {
  return !!navigator.mediaDevices?.getUserMedia && typeof WebSocket !== 'undefined' && (canRecordOpus() || typeof AudioContext !== 'undefined');
}

interface DeepgramResult {
  type?: string;
  is_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
}

function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Ouvre le micro et un WebSocket Deepgram ; `stop()` termine proprement (CloseStream). */
export async function startDictation(opts: { language: string; model: string; apiKey: string } & DictationHandlers): Promise<{ stop(): void }> {
  opts.onState('connecting');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    opts.onState('error', i18n.t('ai:dictation.denied'));
    return { stop() {} };
  }

  // tout ce qui suit getUserMedia peut échouer : on libère alors ce qui a déjà été pris
  let ctx: AudioContext | null = null;
  let ws: WebSocket | null = null;
  try {
    const opus = canRecordOpus();
    const audio = new AudioContext();
    ctx = audio;
    const source = audio.createMediaStreamSource(stream);
    const params = new URLSearchParams({
      model: opts.model,
      language: opts.language,
      smart_format: 'true',
      punctuate: 'true',
      interim_results: 'true',
      endpointing: '300',
    });
    if (!opus) {
      params.set('encoding', 'linear16');
      params.set('sample_rate', String(audio.sampleRate));
      params.set('channels', '1');
    }
    const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', opts.apiKey]);
    ws = socket;
    let stopped = false;

    // niveau du micro, ≈ 15 fois par seconde
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const levelTimer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      opts.onLevel?.(Math.min(1, Math.sqrt(sum / samples.length) * 4));
    }, 66);

    let recorder: MediaRecorder | null = null;
    let processor: ScriptProcessorNode | null = null;

    const startAudio = () => {
      if (opus) {
        recorder = new MediaRecorder(stream, { mimeType: OPUS });
        recorder.ondataavailable = (ev) => {
          if (ev.data.size && socket.readyState === WebSocket.OPEN) socket.send(ev.data);
        };
        recorder.start(250);
      } else {
        processor = audio.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (ev) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(floatToInt16(ev.inputBuffer.getChannelData(0)).buffer);
        };
        source.connect(processor);
        processor.connect(audio.destination);
      }
    };

    const release = () => {
      window.clearInterval(levelTimer);
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      processor?.disconnect();
      source.disconnect();
      for (const t of stream.getTracks()) t.stop();
      void audio.close();
    };

    socket.onopen = () => {
      startAudio();
      opts.onState('listening');
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: DeepgramResult;
      try {
        msg = JSON.parse(ev.data) as DeepgramResult;
      } catch {
        return;
      }
      if (msg.type !== 'Results') return;
      const text = msg.channel?.alternatives?.[0]?.transcript ?? '';
      if (msg.is_final) {
        if (text.trim()) opts.onFinal(text);
      } else {
        opts.onInterim(text);
      }
    };
    socket.onclose = (ev) => {
      if (stopped) return;
      stopped = true;
      release();
      if (ev.code !== 1000) opts.onState('error', i18n.t('ai:dictation.failed', { detail: ev.reason || String(ev.code) }));
      else opts.onState('idle');
    };

    return {
      stop() {
        if (stopped) return;
        stopped = true;
        if (socket.readyState === WebSocket.OPEN) {
          // Deepgram envoie les derniers résultats puis ferme la connexion
          socket.send(JSON.stringify({ type: 'CloseStream' }));
        } else if (socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
        release();
        opts.onState('idle');
      },
    };
  } catch (err) {
    for (const t of stream.getTracks()) t.stop();
    if (ctx) void ctx.close().catch(() => undefined);
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
    throw err;
  }
}
