export type Provider = "codex" | "openai" | "anthropic" | "openrouter" | "ollama";

export type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type CodexProgressEvent = {
  kind: "status" | "command" | "reasoning" | "fileChange";
  eventType: string;
  message: string;
  command?: string | null;
  filePath?: string | null;
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
  backgroundMode: "transparent" | "solid";
  theme: "dark" | "light";
  inputTransparent: boolean;
  messageTransparent: boolean;
  textColor: string;
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
