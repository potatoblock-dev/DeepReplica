import type {
  ContentAnnotation,
  ServerToolStep,
} from "../api/streamChat";
import { idbRequest, openDb } from "../db/openDb";

export type ChatRole = "user" | "assistant" | "system";

export type TitleSource = "default" | "api" | "manual";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  /** Parent message id; `null` is a root. Legacy rows are backfilled on read. */
  parentId: string | null;
  reasoningContent?: string;
  /** Wall-clock ms when the first reasoning delta arrived. */
  reasoningStartedAt?: number;
  /** Wall-clock ms when streaming finished (or reasoning ended). */
  reasoningEndedAt?: number;
  serverToolCalls?: ServerToolStep[];
  annotations?: ContentAnnotation[];
  createdAt: number;
};

export type Conversation = {
  id: string;
  title: string;
  /** Who last set the title; manual wins over API/truncation. */
  titleSource: TitleSource;
  /** Leaf of the active branch used for display and the next send. */
  activeLeafId: string | null;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

export type AssistantPatch = {
  content: string;
  reasoningContent?: string;
  reasoningStartedAt?: number;
  reasoningEndedAt?: number;
  serverToolCalls?: ServerToolStep[];
  annotations?: ContentAnnotation[];
};

type MessageInput = Omit<ChatMessage, "id" | "createdAt" | "parentId"> & {
  id?: string;
  createdAt?: number;
  parentId?: string | null;
};

/** Backfills parentId / titleSource / activeLeafId for legacy conversation rows. */
export function normalizeConversation(raw: Conversation): Conversation {
  const messages = raw.messages.map((m, index, arr) => {
    if (m.parentId === null || typeof m.parentId === "string") {
      return m;
    }
    return {
      ...m,
      parentId: index === 0 ? null : arr[index - 1].id,
    };
  });
  const titleSource: TitleSource =
    raw.titleSource ?? (raw.title === "新对话" ? "default" : "api");
  const activeLeafId =
    raw.activeLeafId ?? (messages.length > 0 ? messages[messages.length - 1].id : null);
  return {
    ...raw,
    titleSource,
    activeLeafId,
    messages,
  };
}

/** Looks up a message by id inside a conversation. */
export function findMessage(
  conversation: Conversation,
  messageId: string,
): ChatMessage | undefined {
  return conversation.messages.find((m) => m.id === messageId);
}

/** Walks parent links from a node to the deepest newest descendant leaf. */
export function deepestLeafId(conversation: Conversation, nodeId: string): string {
  const children = conversation.messages
    .filter((m) => m.parentId === nodeId)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (children.length === 0) {
    return nodeId;
  }
  return deepestLeafId(conversation, children[0].id);
}

/** Returns the active branch path (root → leaf) for display and API history. */
export function getActivePath(conversation: Conversation): ChatMessage[] {
  const conv = normalizeConversation(conversation);
  if (conv.messages.length === 0) {
    return [];
  }
  const byId = new Map(conv.messages.map((m) => [m.id, m]));
  const leafId = conv.activeLeafId ?? conv.messages[conv.messages.length - 1].id;
  const path: ChatMessage[] = [];
  const seen = new Set<string>();
  let current = byId.get(leafId);
  while (current && !seen.has(current.id)) {
    path.push(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

/** Sibling messages that share the same parent and role (branch switcher). */
export function listSiblings(
  conversation: Conversation,
  messageId: string,
): ChatMessage[] {
  const conv = normalizeConversation(conversation);
  const target = findMessage(conv, messageId);
  if (!target) {
    return [];
  }
  return conv.messages
    .filter((m) => m.parentId === target.parentId && m.role === target.role)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Creates a new empty conversation and writes it to IndexedDB. */
export async function createConversation(title = "新对话"): Promise<Conversation> {
  const now = Date.now();
  const conversation: Conversation = {
    id: crypto.randomUUID(),
    title,
    titleSource: "default",
    activeLeafId: null,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  await putConversation(conversation);
  return conversation;
}

/** Returns all conversations sorted by most recently updated (normalized). */
export async function listConversations(): Promise<Conversation[]> {
  const db = await openDb();
  const all = (await idbRequest(
    db.transaction("conversations", "readonly").objectStore("conversations").getAll(),
  )) as Conversation[];
  return all.map(normalizeConversation).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Loads one conversation by id, or null if missing. */
export async function getConversation(id: string): Promise<Conversation | null> {
  const db = await openDb();
  const row = (await idbRequest(
    db.transaction("conversations", "readonly").objectStore("conversations").get(id),
  )) as Conversation | undefined;
  return row ? normalizeConversation(row) : null;
}

/** Overwrites a conversation record in IndexedDB. */
export async function putConversation(conversation: Conversation): Promise<void> {
  const db = await openDb();
  await idbRequest(
    db.transaction("conversations", "readwrite").objectStore("conversations").put(conversation),
  );
}

/** Deletes a conversation permanently from IndexedDB. */
export async function deleteConversation(id: string): Promise<void> {
  const db = await openDb();
  await idbRequest(
    db.transaction("conversations", "readwrite").objectStore("conversations").delete(id),
  );
}

/** Clears every conversation; vault / settings / usage stores are untouched. */
export async function deleteAllConversations(): Promise<void> {
  const db = await openDb();
  await idbRequest(
    db.transaction("conversations", "readwrite").objectStore("conversations").clear(),
  );
}

/** Renames a conversation and locks the title against API/truncation updates. */
export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<Conversation> {
  const conversation = await getConversation(conversationId);
  if (!conversation) {
    throw new Error("Conversation not found");
  }
  const next = title.trim() || "新对话";
  conversation.title = next;
  conversation.titleSource = "manual";
  conversation.updatedAt = Date.now();
  await putConversation(conversation);
  return conversation;
}

/** Applies an API-generated title when the user has not manually renamed. */
export async function applyApiTitle(
  conversationId: string,
  title: string,
): Promise<Conversation | null> {
  const conversation = await getConversation(conversationId);
  if (!conversation) {
    return null;
  }
  if (conversation.titleSource === "manual") {
    return conversation;
  }
  const next = title.trim();
  if (!next) {
    return conversation;
  }
  conversation.title = next.slice(0, 80);
  conversation.titleSource = "api";
  conversation.updatedAt = Date.now();
  await putConversation(conversation);
  return conversation;
}

/** Sets the active branch leaf (and deepens to newest descendant). */
export async function setActiveLeaf(
  conversationId: string,
  messageId: string,
): Promise<Conversation> {
  const conversation = await getConversation(conversationId);
  if (!conversation) {
    throw new Error("Conversation not found");
  }
  if (!findMessage(conversation, messageId)) {
    throw new Error("Message not found");
  }
  conversation.activeLeafId = deepestLeafId(conversation, messageId);
  conversation.updatedAt = Date.now();
  await putConversation(conversation);
  return conversation;
}

/**
 * Appends a child message under `parentId` (or under the current leaf when omitted),
 * updates activeLeafId, and may truncate-title when still on the default source.
 */
export async function appendMessage(
  conversationId: string,
  message: MessageInput,
): Promise<Conversation> {
  const conversation = await getConversation(conversationId);
  if (!conversation) {
    throw new Error("Conversation not found");
  }
  const parentId =
    message.parentId !== undefined
      ? message.parentId
      : conversation.activeLeafId;
  const nextMessage: ChatMessage = {
    id: message.id ?? crypto.randomUUID(),
    role: message.role,
    content: message.content,
    parentId,
    reasoningContent: message.reasoningContent,
    reasoningStartedAt: message.reasoningStartedAt,
    reasoningEndedAt: message.reasoningEndedAt,
    serverToolCalls: message.serverToolCalls,
    annotations: message.annotations,
    createdAt: message.createdAt ?? Date.now(),
  };
  conversation.messages.push(nextMessage);
  conversation.activeLeafId = nextMessage.id;
  conversation.updatedAt = Date.now();
  if (
    conversation.titleSource === "default" &&
    nextMessage.role === "user" &&
    nextMessage.content.trim()
  ) {
    conversation.title = nextMessage.content.trim().slice(0, 40);
  }
  await putConversation(conversation);
  return conversation;
}

/** Alias kept for call sites that want an explicit parent. */
export async function appendChildMessage(
  conversationId: string,
  parentId: string | null,
  message: Omit<MessageInput, "parentId">,
): Promise<Conversation> {
  return appendMessage(conversationId, { ...message, parentId });
}

/** Patches an assistant message by id (streaming / continue / final write). */
export async function updateAssistant(
  conversationId: string,
  assistantId: string,
  patch: AssistantPatch,
): Promise<Conversation> {
  const conversation = await getConversation(conversationId);
  if (!conversation) {
    throw new Error("Conversation not found");
  }
  const index = conversation.messages.findIndex((m) => m.id === assistantId);
  if (index < 0 || conversation.messages[index].role !== "assistant") {
    throw new Error("No assistant message to update");
  }
  conversation.messages[index] = {
    ...conversation.messages[index],
    content: patch.content,
    reasoningContent: patch.reasoningContent,
    reasoningStartedAt: patch.reasoningStartedAt ?? conversation.messages[index].reasoningStartedAt,
    reasoningEndedAt: patch.reasoningEndedAt ?? conversation.messages[index].reasoningEndedAt,
    serverToolCalls: patch.serverToolCalls ?? conversation.messages[index].serverToolCalls,
    annotations: patch.annotations ?? conversation.messages[index].annotations,
  };
  conversation.updatedAt = Date.now();
  await putConversation(conversation);
  return conversation;
}

/**
 * Replaces the last assistant on the active path (compat for older call sites).
 * Prefer `updateAssistant` when the id is known.
 */
export async function updateLastAssistant(
  conversationId: string,
  patch: AssistantPatch,
): Promise<Conversation> {
  const conversation = await getConversation(conversationId);
  if (!conversation) {
    throw new Error("Conversation not found");
  }
  const path = getActivePath(conversation);
  for (let i = path.length - 1; i >= 0; i -= 1) {
    if (path[i].role === "assistant") {
      return updateAssistant(conversationId, path[i].id, patch);
    }
  }
  throw new Error("No assistant message to update");
}
