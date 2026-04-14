/**
 * voice.ts — Dual-agent voice layer for SUPREME
 *
 * Priority order:
 *   1. Vapi TTS API  (highest quality, needs VITE_VAPI_API_KEY)
 *   2. Browser speechSynthesis (fallback, always works)
 */

const VAPI_KEY = (import.meta as any).env?.VITE_VAPI_API_KEY as string | undefined;

// Voice profiles per agent — mutable arrays to avoid readonly conflicts
interface VoiceProfile {
  vapiVoiceId: string;
  pitch: number;
  rate: number;
  voiceHint: string[];
}

const VOICE_PROFILES: Record<string, VoiceProfile> = {
  prosecution: {
    vapiVoiceId: '21m00Tcm4TlvDq8ikWAM',  // Rachel — strong/clear
    pitch: 0.85,
    rate: 0.92,
    voiceHint: ['Google UK English Male', 'Microsoft David', 'Alex', 'en-GB'],
  },
  defense: {
    vapiVoiceId: 'AZnzlk1XvdvUeBnXmlld',   // Domi — calm/measured
    pitch: 1.05,
    rate: 0.88,
    voiceHint: ['Google UK English Female', 'Microsoft Zira', 'Samantha', 'en-US'],
  },
  judge: {
    vapiVoiceId: 'pNInz6obpgDQGcFmaJgB',   // Adam — deep/wise
    pitch: 0.75,
    rate: 0.80,
    voiceHint: ['Google US English', 'Microsoft David', 'Daniel', 'en-US'],
  },
};

type AgentRole = 'prosecution' | 'defense' | 'judge';

let muted = false;
let currentAudio: HTMLAudioElement | null = null;

export function setMuted(value: boolean) {
  muted = value;
  if (value) stopSpeaking();
}
export function isMuted() { return muted; }

export function stopSpeaking() {
  window.speechSynthesis?.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
}

/**
 * Speak text as the given agent.
 * Returns a promise that resolves when speech ends.
 */
export async function speak(text: string, agent: AgentRole): Promise<void> {
  if (muted || !text.trim()) return;

  const profile = VOICE_PROFILES[agent] ?? VOICE_PROFILES.prosecution;

  // Try Vapi TTS first
  if (VAPI_KEY) {
    try {
      await speakVapi(text, profile.vapiVoiceId);
      return;
    } catch (e) {
      console.warn('[voice] Vapi TTS failed, falling back to browser:', e);
    }
  }

  // Browser fallback
  await speakBrowser(text, profile.pitch, profile.rate, profile.voiceHint);
}

// ── Vapi TTS ──────────────────────────────────────────────────────────────────
async function speakVapi(text: string, voiceId: string): Promise<void> {
  const res = await fetch('https://api.vapi.ai/tts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VAPI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: text.slice(0, 500),
      voice: { provider: 'openai', voiceId },
    }),
  });

  if (!res.ok) throw new Error(`Vapi TTS ${res.status}`);

  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);

  await new Promise<void>((resolve, reject) => {
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended  = () => { URL.revokeObjectURL(url); resolve(); };
    audio.onerror  = () => { URL.revokeObjectURL(url); reject(new Error('audio play error')); };
    audio.play().catch(reject);
  });
}

// ── Browser speechSynthesis ────────────────────────────────────────────────────
function pickVoice(hints: string[]): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  for (const hint of hints) {
    const found = voices.find(v => v.name.includes(hint) || v.lang.startsWith(hint));
    if (found) return found;
  }
  return voices.find(v => v.lang.startsWith('en')) ?? null;
}

function speakBrowser(text: string, pitch: number, rate: number, hints: string[]): Promise<void> {
  return new Promise((resolve) => {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text.slice(0, 400));
    utter.pitch  = pitch;
    utter.rate   = rate;
    utter.volume = 1;

    const applyVoice = () => {
      const v = pickVoice(hints);
      if (v) utter.voice = v;
    };

    utter.onend   = () => resolve();
    utter.onerror = () => resolve();  // resolve even on error so app doesn't hang

    if (window.speechSynthesis.getVoices().length === 0) {
      window.speechSynthesis.addEventListener('voiceschanged', () => {
        applyVoice();
        window.speechSynthesis.speak(utter);
      }, { once: true });
    } else {
      applyVoice();
      window.speechSynthesis.speak(utter);
    }
  });
}
