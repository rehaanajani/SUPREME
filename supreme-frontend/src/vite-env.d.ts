/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_DEBUG_API?: string;
  readonly VITE_VAPI_PUBLIC_KEY?: string;
  readonly VITE_VAPI_VOICE_PROVIDER?: string;
  readonly VITE_VAPI_MODEL_PROVIDER?: string;
  readonly VITE_VAPI_MODEL?: string;
  readonly VITE_VAPI_PROSECUTOR_VOICE?: string;
  readonly VITE_VAPI_DEFENSE_VOICE?: string;
  readonly VITE_VAPI_JUDGE_VOICE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
