import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { onShutdownSignal } from "../src/shutdown.js";

describe("onShutdownSignal (Telegram review: Ctrl+C under tsx)", () => {
  it("runs the shutdown once and keeps listening, so a relayed second Ctrl+C cannot kill the process mid-shutdown", () => {
    const proc = new EventEmitter();
    const handler = vi.fn();
    onShutdownSignal(handler, proc);
    proc.emit("SIGINT"); // the terminal's Ctrl+C
    proc.emit("SIGINT"); // the same Ctrl+C relayed by tsx
    proc.emit("SIGTERM");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("SIGINT");
    // With no listener left, Node would apply the default action (exit 130) to the repeat.
    expect(proc.listenerCount("SIGINT")).toBe(1);
    expect(proc.listenerCount("SIGTERM")).toBe(1);
  });
});
