import { request } from './client';

export interface HealthStatus {
    llm: boolean;
    qdrant: boolean;
    session: boolean;
    voice: boolean;
}

export async function checkHealth(): Promise<HealthStatus> {
    const status: HealthStatus = { llm: false, qdrant: false, session: false, voice: false };

    // Backend health (implies LLM connectivity)
    try {
        await request<{ status: string }>('/health', { timeoutMs: 5_000 });
        status.llm = true;
    } catch { /* offline */ }

    // RAG / Qdrant
    try {
        const rag = await request<Record<string, unknown>>('/api/debug/rag', { timeoutMs: 5_000 });
        status.qdrant = rag?.qdrant_client_available === true && rag?.collection_exists === true;
    } catch { /* offline */ }

    // Session store
    try {
        const sess = await request<Record<string, unknown>>('/api/debug/session-store', { timeoutMs: 5_000 });
        status.session = sess?.backend !== undefined;
    } catch { /* offline */ }

    // Voice — client-side check for Vapi key
    const vapiKey = import.meta.env.VITE_VAPI_PUBLIC_KEY;
    status.voice = !!vapiKey && vapiKey.length > 10;

    return status;
}
