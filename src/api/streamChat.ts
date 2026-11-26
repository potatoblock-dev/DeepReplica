export type StreamChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  reasoning_content?: string;
  server_tool_calls?: ServerToolStep[];
  /** Beta Chat Prefix Completion: continue from this assistant content. */
  prefix?: boolean;
};

export type UrlCitationAnnotation = {
  type: "url_citation";
  url_citation: {
    url: string;
    title?: string;
    start_index: number;
    end_index: number;
  };
};

export type ContentAnnotation = UrlCitationAnnotation;

export type ServerToolSource = {
  type?: string;
  url: string;
  title?: string;
  snippet?: string;
  site_name?: string;
  site_icon?: string;
  published_at?: string | null;
};

export type ServerToolCall = {
  index: number;
  id: string;
  type: string;
  kind: string;
  action: {
    type: string;
    queries?: string[];
    url?: string;
    pattern?: string;
  };
  status: "completed" | "failed" | string;
  sources?: ServerToolSource[];
  page?: { url: string; title?: string; published_at?: string | null };
  signature?: string;
  error?: { code?: string };
};

export type ServerToolStep = {
  index: number;
  reasoning_content?: string;
  calls: ServerToolCall[];
};

export type ServerToolEvent = {
  type: "step_reasoning_done" | "call_started" | "call_completed" | string;
  step: number;
  call?: ServerToolCall;
};

export type StreamUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type StreamChatOptions = {
  apiBase: string;
  apiKey: string;
  model?: string;
  thinkingEnabled: boolean;
  /**
   * When true, declare `deepseek_web_search` + `deepseek_read_url`.
   * Independent of thinking (search-only vs deep-thinking search).
   */
  webToolsEnabled?: boolean;
  /** When true, request a conversation title via DeepSeek `title` extension. */
  enableTitle?: boolean;
  /**
   * When true, last message must be an assistant with `prefix: true` and the
   * request goes to the beta Chat Completions endpoint.
   */
  prefixCompletion?: boolean;
  /**
   * Sampling temperature 0–2. Omit (or leave undefined) to use the API default.
   */
  temperature?: number;
  messages: StreamChatMessage[];
  signal?: AbortSignal;
  onReasoningDelta: (text: string) => void;
  onContentDelta: (text: string) => void;
  onToolEvent?: (event: ServerToolEvent) => void;
  onAnnotations?: (annotations: ContentAnnotation[]) => void;
  onServerToolCalls?: (steps: ServerToolStep[]) => void;
  onUsage?: (usage: StreamUsage) => void;
  /** Fired when a conversation title arrives (usually on the final stream chunk). */
  onTitle?: (title: string) => void;
};

type StreamDelta = {
  content?: string | null;
  reasoning_content?: string | null;
  role?: string;
  title?: string | null;
  annotations?: ContentAnnotation[];
  server_tool_calls?: ServerToolStep[];
};

type StreamChoice = {
  delta?: StreamDelta;
  finish_reason?: string | null;
  server_tool_event?: ServerToolEvent;
};

type StreamChunk = {
  choices?: StreamChoice[];
  usage?: StreamUsage;
  error?: { message?: string };
};

/** Builds the Chat Completions URL; prefix continuation uses the beta path. */
function completionsUrl(apiBase: string, prefixCompletion: boolean): string {
  const base = apiBase.replace(/\/$/, "");
  if (!prefixCompletion) {
    return `${base}/chat/completions`;
  }
  if (/\/beta$/i.test(base)) {
    return `${base}/chat/completions`;
  }
  return `${base}/beta/chat/completions`;
}

/** Streams a Chat Completions reply; optional DeepSeek web tools for search/read in thinking. */
export async function streamChat(options: StreamChatOptions): Promise<void> {
  const enableWebTools = Boolean(options.webToolsEnabled);
  const webTools = enableWebTools
    ? ([{ type: "deepseek_web_search" }, { type: "deepseek_read_url" }] as const)
    : null;
  const prefixCompletion = Boolean(options.prefixCompletion);
  const url = completionsUrl(options.apiBase, prefixCompletion);

  const body: Record<string, unknown> = {
    model: options.model ?? "deepseek-flash",
    messages: options.messages.map((m) => {
      const row: Record<string, unknown> = {
        role: m.role,
        content: m.content,
      };
      if (m.prefix) {
        row.prefix = true;
      }
      // Always echo prior tool/reasoning blocks so later turns stay coherent
      // even if web search is toggled off for the current request.
      if (m.role === "assistant") {
        if (m.reasoning_content) {
          row.reasoning_content = m.reasoning_content;
        }
        if (m.server_tool_calls?.length) {
          row.server_tool_calls = m.server_tool_calls;
        }
      }
      return row;
    }),
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: options.thinkingEnabled ? "enabled" : "disabled" },
  };
  if (webTools && !prefixCompletion) {
    body.tools = webTools;
  }
  if (options.enableTitle) {
    body.title = { enabled: true };
  }
  if (typeof options.temperature === "number" && Number.isFinite(options.temperature)) {
    body.temperature = options.temperature;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API ${response.status}: ${errText.slice(0, 400)}`);
  }
  if (!response.body) {
    throw new Error("Response body missing");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        return;
      }
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        continue;
      }
      if (chunk.error?.message) {
        throw new Error(chunk.error.message);
      }
      if (chunk.usage && options.onUsage) {
        options.onUsage(chunk.usage);
      }
      const choice = chunk.choices?.[0];
      if (!choice) {
        continue;
      }
      if (choice.server_tool_event && options.onToolEvent) {
        options.onToolEvent(choice.server_tool_event);
      }
      const delta = choice.delta;
      if (!delta) {
        continue;
      }
      if (delta.reasoning_content) {
        options.onReasoningDelta(delta.reasoning_content);
      }
      if (delta.content) {
        options.onContentDelta(delta.content);
      }
      if (delta.title && options.onTitle) {
        options.onTitle(delta.title);
      }
      if (delta.annotations?.length && options.onAnnotations) {
        options.onAnnotations(delta.annotations);
      }
      if (delta.server_tool_calls?.length && options.onServerToolCalls) {
        options.onServerToolCalls(delta.server_tool_calls);
      }
    }
  }
}
