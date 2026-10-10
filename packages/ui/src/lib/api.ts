import type {
  Artifact,
  Conversation,
  Escalation,
  EscalationAnswer,
  Finding,
  FsDirsResponse,
  GroveEvent,
  InboxResponse,
  Project,
  ProjectWorktreesResponse,
  Round,
  Task,
  TaskMessage,
  Worker,
} from "@grove/shared";

declare global {
  interface Window {
    __GROVE_TOKEN__?: string;
  }
}

export function getToken(): string {
  if (window.__GROVE_TOKEN__) return window.__GROVE_TOKEN__;
  const url = new URL(location.href);
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) {
    localStorage.setItem("grove_token", fromQuery);
    url.searchParams.delete("token");
    history.replaceState(null, "", url.toString());
    return fromQuery;
  }
  return localStorage.getItem("grove_token") ?? "";
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${getToken()}`,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

export interface TaskDetail {
  task: Task;
  workers: Worker[];
  rounds: Round[];
  findings: Finding[];
  escalations: Escalation[];
  messages: TaskMessage[];
}

export const messageTask = (id: string, message: string) =>
  api<{ delivery: "live" | "queued" }>("POST", `/api/tasks/${id}/message`, { message });

export const deleteProject = (id: string) => api<{ ok: boolean }>("DELETE", `/api/projects/${id}`);

export const fetchProjectWorktrees = (id: string) =>
  api<ProjectWorktreesResponse>("GET", `/api/projects/${id}/worktrees`);

export const browseDirs = (dirPath?: string) =>
  api<FsDirsResponse>(
    "GET",
    `/api/fs/dirs${dirPath !== undefined ? `?path=${encodeURIComponent(dirPath)}` : ""}`,
  );

export const fetchConversations = () =>
  api<{ conversations: Conversation[] }>("GET", "/api/conversations");

/** The "Recently deleted" set — soft-deleted conversations, recoverable. */
export const fetchTrashedConversations = () =>
  api<{ conversations: Conversation[] }>("GET", "/api/conversations/trashed");

/** Default delete: move a conversation to the trash (recoverable). */
export const deleteConversation = (id: string) =>
  api<{ ok: boolean }>("DELETE", `/api/conversations/${id}`);

export const restoreConversation = (id: string) =>
  api<{ ok: boolean }>("POST", `/api/conversations/${id}/restore`);

/** Permanent hard delete: removes the conversation and its transcript for good. */
export const permanentlyDeleteConversation = (id: string) =>
  api<{ ok: boolean }>("DELETE", `/api/conversations/${id}/permanent`);

export const updateConversation = (id: string, data: { title?: string; model?: string | null }) =>
  api<{ conversation: Conversation }>("PATCH", `/api/conversations/${id}`, data);

export const fetchArtifacts = (conversationId: string) =>
  api<{ artifacts: Artifact[] }>("GET", `/api/conversations/${conversationId}/artifacts`);

/** No conversationId → the daemon starts a new conversation and returns its id. */
export const sendChat = (message: string, conversationId?: string, model?: string | null) =>
  api<{ ok: boolean; conversationId: string }>("POST", "/api/chat", {
    message,
    ...(conversationId !== undefined && { conversationId }),
    ...(model !== undefined && { model }),
  });

export const fetchProjects = () => api<{ projects: Project[] }>("GET", "/api/projects");
export const fetchTasks = () => api<{ tasks: Task[] }>("GET", "/api/tasks");
export const fetchTask = (id: string) => api<TaskDetail>("GET", `/api/tasks/${id}`);
export const fetchEvents = (id: string, after = 0) =>
  api<{ events: GroveEvent[] }>("GET", `/api/tasks/${id}/events?after=${after}`);
export const fetchHealth = () => api<{ ok: boolean; version: string }>("GET", "/api/health");

export const fetchInbox = () => api<InboxResponse>("GET", "/api/inbox");

export const answerEscalation = (id: string, answer: EscalationAnswer) =>
  api("POST", `/api/escalations/${id}/answer`, { answer });

export function openEventsSocket(onEvent: (event: GroveEvent) => void): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const connect = () => {
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(getToken())}`);
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data as string) as GroveEvent);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (closed) return;
      // Re-check `closed` when the timer fires, not only when it is scheduled:
      // teardown can land inside the delay, and a reconnect after teardown
      // leaks a socket nobody holds a reference to.
      retry = setTimeout(() => {
        retry = null;
        if (!closed) connect();
      }, 1500);
    };
  };
  connect();
  return () => {
    closed = true;
    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
    if (!ws) return;
    // Closing a socket that is still CONNECTING aborts the handshake, which the
    // browser reports as "closed before the connection is established" and the
    // dev proxy reports as EPIPE. React StrictMode's double-invoked effect hits
    // this on every mount in development. Waiting for `open` closes cleanly.
    if (ws.readyState === WebSocket.CONNECTING) {
      const socket = ws;
      socket.onclose = null;
      socket.addEventListener("open", () => socket.close(), { once: true });
      return;
    }
    ws.close();
  };
}
