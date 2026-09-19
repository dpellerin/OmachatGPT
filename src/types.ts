export type Role = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
}

export interface PersistedState {
  version: 3;
  threadId: string;
  model: string;
  updatedAt: string;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: JsonRpcError;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{reasoningEffort: string}>;
}

export interface ThreadItem {
  id: string;
  type: string;
  text?: string;
  phase?: "commentary" | "final_answer" | null;
  content?: Array<{type: string; text?: string}>;
  results?: unknown[] | null;
}

export interface ThreadTurn {
  id: string;
  status: string;
  items: ThreadItem[];
}

export interface CodexThread {
  id: string;
  turns: ThreadTurn[];
}
