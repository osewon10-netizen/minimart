import { OLLAMA_URL } from "./paths.js";

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export async function ollamaGenerate(
  model: string,
  prompt: string,
  options?: Record<string, unknown>
): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false, ...options }),
    signal: AbortSignal.timeout(120000), // 2 min for generation
  });

  if (!res.ok) throw new Error(`Ollama error (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return json.response;
}

export async function ollamaListModels(): Promise<OllamaModel[]> {
  const res = await fetch(`${OLLAMA_URL}/api/tags`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Ollama error (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return json.models ?? [];
}
