import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

const ids = (list: Array<{ id: string }>) => list.map((c) => c.id);

describe("deleting conversations", () => {
  it("soft-deletes: hidden from the rail, recoverable in the trash, transcript intact", async () => {
    const conv = h.store.createConversation({ title: "to trash" });
    h.store.appendEvent(conv.id, null, "chat.user", { text: "hi" });
    h.store.appendEvent(conv.id, null, "chat.text", { text: "hello" });

    const del = await h.api("DELETE", `/api/conversations/${conv.id}`);
    expect(del.status).toBe(200);

    // Gone from the live rail, present in "Recently deleted" with a tombstone.
    const live = await h.api("GET", "/api/conversations");
    expect(ids(live.json.conversations)).not.toContain(conv.id);

    const trash = await h.api("GET", "/api/conversations/trashed");
    expect(ids(trash.json.conversations)).toContain(conv.id);
    expect(typeof trash.json.conversations[0].deletedAt).toBe("number");

    // Soft delete keeps the transcript so a restore brings the chat back whole.
    expect(h.store.listEvents(conv.id)).toHaveLength(2);
  });

  it("restores a trashed conversation back to the rail", async () => {
    const conv = h.store.createConversation({ title: "oops" });
    await h.api("DELETE", `/api/conversations/${conv.id}`);

    const restore = await h.api("POST", `/api/conversations/${conv.id}/restore`);
    expect(restore.status).toBe(200);

    const live = await h.api("GET", "/api/conversations");
    expect(ids(live.json.conversations)).toContain(conv.id);
    const trash = await h.api("GET", "/api/conversations/trashed");
    expect(trash.json.conversations).toHaveLength(0);
  });

  it("permanently deletes the conversation and its transcript, leaving siblings untouched", async () => {
    const conv = h.store.createConversation({ title: "gone for good" });
    h.store.appendEvent(conv.id, null, "chat.user", { text: "hi" });
    h.store.appendEvent(conv.id, null, "chat.done", { ok: true });
    const other = h.store.createConversation({ title: "keep me" });
    h.store.appendEvent(other.id, null, "chat.user", { text: "still here" });

    // The UI flow trashes first, then permanently deletes behind a 2nd confirm.
    await h.api("DELETE", `/api/conversations/${conv.id}`);
    const purge = await h.api("DELETE", `/api/conversations/${conv.id}/permanent`);
    expect(purge.status).toBe(200);

    // Row and transcript are gone; it can never be reopened.
    expect(h.store.getConversation(conv.id)).toBeNull();
    expect(h.store.listEvents(conv.id)).toHaveLength(0);
    const replay = await h.api("GET", `/api/tasks/${conv.id}/events`);
    expect(replay.json.events).toHaveLength(0);

    // The sibling conversation and its events survive.
    expect(h.store.getConversation(other.id)).not.toBeNull();
    expect(h.store.listEvents(other.id)).toHaveLength(1);
    const live = await h.api("GET", "/api/conversations");
    expect(ids(live.json.conversations)).toEqual([other.id]);
    const trash = await h.api("GET", "/api/conversations/trashed");
    expect(trash.json.conversations).toHaveLength(0);
  });

  it("permanently deletes straight from the live list too", async () => {
    const conv = h.store.createConversation({ title: "direct purge" });
    h.store.appendEvent(conv.id, null, "chat.user", { text: "hi" });

    const purge = await h.api("DELETE", `/api/conversations/${conv.id}/permanent`);
    expect(purge.status).toBe(200);
    expect(h.store.getConversation(conv.id)).toBeNull();
    expect(h.store.listEvents(conv.id)).toHaveLength(0);
  });

  it("rejects delete, restore, and permanent-delete of an unknown conversation", async () => {
    const del = await h.api("DELETE", "/api/conversations/conv_nope");
    expect(del.status).toBe(400);
    expect(del.json.error).toContain("unknown conversation");

    const restore = await h.api("POST", "/api/conversations/conv_nope/restore");
    expect(restore.status).toBe(400);

    const purge = await h.api("DELETE", "/api/conversations/conv_nope/permanent");
    expect(purge.status).toBe(400);
  });
});
