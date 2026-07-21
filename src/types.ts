export type Provider = "openai" | "anthropic" | "openrouter" | "ollama";

export type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type AttachedFile = {
  id: string;
  name: string;
  type: string;
  size: number;
  text?: string;
  status: "ready" | "unsupported" | "error";
};

export type ProviderSettings = {
  provider: Provider;
  model: string;
  endpoint: string;
  alwaysOnTop: boolean;
  translucent: boolean;
  theme: "dark" | "light";
};

export type OperationPreview = {
  summary: string;
  source: string;
  destination?: string;
  action: "list" | "move" | "copy" | "rename" | "delete" | "unknown";
  requiresConfirmation: boolean;
  warnings: string[];
  files: Array<{
    name: string;
    path: string;
    size: number;
    modified?: string;
  }>;
};
