import { useCallback, useEffect, useRef, useState } from 'react';
import { dictationSupported, startDictation, type DictationState } from '@/lib/ai/dictation';
import { getAiSecret, useAiSecretSet } from '@/lib/ai/secrets';
import { useAiSettings } from '@/lib/ai/store';

/** Dictée Deepgram pour un champ de saisie : état, texte provisoire, niveau du micro. Arrêt au démontage. */
export function useDictation(opts: { language: string; onFinal: (text: string) => void }): {
  available: boolean;
  state: DictationState;
  interim: string;
  level: number;
  error: string | null;
  start(): Promise<void>;
  stop(): void;
  toggle(): void;
} {
  const enabled = useAiSettings((s) => s.enabled && s.dictation.enabled);
  const model = useAiSettings((s) => s.dictation.model);
  const setting = useAiSettings((s) => s.dictation.language);
  const hasKey = useAiSecretSet('deepgram');
  const available = enabled && !!hasKey && dictationSupported();

  const [state, setState] = useState<DictationState>('idle');
  const [interim, setInterim] = useState('');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<{ stop(): void } | null>(null);
  // génération : incrémentée à chaque start/stop, pour jeter une session arrivée après un arrêt
  const generation = useRef(0);
  const connecting = useRef(false);
  const onFinal = useRef(opts.onFinal);
  onFinal.current = opts.onFinal;
  const language = setting === 'auto' ? opts.language : setting;

  const stop = useCallback(() => {
    generation.current++;
    connecting.current = false;
    session.current?.stop();
    session.current = null;
    setInterim('');
    setLevel(0);
  }, []);

  const start = useCallback(async () => {
    if (session.current || connecting.current) return;
    const gen = ++generation.current;
    connecting.current = true;
    const apiKey = await getAiSecret('deepgram');
    if (gen !== generation.current) return;
    if (!apiKey) {
      connecting.current = false;
      return;
    }
    setError(null);
    let failed = false;
    let handle: { stop(): void };
    try {
      handle = await startDictation({
        language,
        model,
        apiKey,
        onInterim: setInterim,
        onFinal: (text) => {
          setInterim('');
          onFinal.current(text);
        },
        onLevel: setLevel,
        onState: (s, err) => {
          setState(s);
          if (s === 'error') {
            failed = true;
            setError(err ?? null);
            session.current = null;
            setInterim('');
            setLevel(0);
          }
        },
      });
    } catch (err) {
      if (gen === generation.current) {
        connecting.current = false;
        setState('error');
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (gen !== generation.current) {
      // arrêt demandé ou démontage pendant la connexion : on ne garde pas la session
      handle.stop();
      return;
    }
    connecting.current = false;
    if (!failed) session.current = handle;
  }, [language, model]);

  const toggle = useCallback(() => {
    // pendant la connexion, un clic arrête (jamais de relance)
    if (session.current || connecting.current) stop();
    else void start();
  }, [start, stop]);

  useEffect(
    () => () => {
      generation.current++;
      connecting.current = false;
      session.current?.stop();
    },
    [],
  );

  return { available, state, interim, level, error, start, stop, toggle };
}
