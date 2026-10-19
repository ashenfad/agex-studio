import { describe, expect, it, vi } from "vitest";
import { Gate } from "./gate.js";

describe("a session's gate", () => {
    it("is held by one taker at a time", () => {
        const gate = new Gate();
        const release = gate.tryTake("turn");
        expect(release).not.toBeNull();
        expect(gate.holder).toBe("turn");
        expect(gate.tryTake("sync")).toBeNull();
        release?.();
        expect(gate.holder).toBeNull();
        expect(gate.tryTake("sync")).not.toBeNull();
    });

    it("lets go once, however often the release is called", () => {
        const gate = new Gate();
        const first = gate.tryTake("edit");
        first?.();
        const second = gate.tryTake("turn");
        first?.();
        expect(gate.holder).toBe("turn");
        second?.();
    });

    it("hands it to a waiter once it's let go", async () => {
        const gate = new Gate();
        const sync = gate.tryTake("sync");
        const turn = gate.take("turn", ["turn"]);
        await Promise.resolve();
        expect(gate.holder).toBe("sync");
        sync?.();
        const release = await turn;
        expect(release).not.toBeNull();
        expect(gate.holder).toBe("turn");
    });

    it("gives way at once to what the taker yields to", async () => {
        const gate = new Gate();
        gate.tryTake("turn");
        expect(await gate.take("fold", ["turn", "fold"])).toBeNull();
    });

    it("gives way to a turn that took it while the taker waited", async () => {
        const gate = new Gate();
        const sync = gate.tryTake("sync");
        // a fold waits for the sync, but not for a turn
        const fold = gate.take("fold", ["turn", "fold"]);
        sync?.();
        // the turn gets there first
        const turn = gate.tryTake("turn");
        expect(turn).not.toBeNull();
        expect(await fold).toBeNull();
    });

    it("serves waiters one after another", async () => {
        const gate = new Gate();
        const order = [];
        const first = gate.tryTake("edit");
        const a = gate.take("sync").then((release) => {
            order.push("sync");
            return release;
        });
        const b = gate.take("turn").then((release) => {
            order.push("turn");
            return release;
        });
        first?.();
        const winner = await Promise.race([a, b]);
        expect(gate.holder).not.toBeNull();
        expect(order).toHaveLength(1);
        winner?.();
        const other = await (order[0] === "sync" ? b : a);
        expect(order).toHaveLength(2);
        other?.();
        expect(gate.holder).toBeNull();
    });

    it("isn't taken when, as it comes free, there's nothing to do", async () => {
        const gate = new Gate();
        let due = true;
        const sync = gate.tryTake("sync");
        const wake = gate.take("turn", ["turn", "fold"], () => due);
        due = false;
        sync?.();
        expect(await wake).toBeNull();
        expect(gate.holder).toBeNull();
    });

    it("waits out only the holders named", async () => {
        const gate = new Gate();
        const turn = gate.tryTake("turn");
        let clear = false;
        void gate.clearOf(["sync", "edit"]).then(() => (clear = true));
        await Promise.resolve();
        expect(clear).toBe(true);
        turn?.();

        const sync = gate.tryTake("sync");
        clear = false;
        const waiting = gate.clearOf(["sync", "edit"]).then(() => (clear = true));
        await Promise.resolve();
        expect(clear).toBe(false);
        sync?.();
        await waiting;
        expect(clear).toBe(true);
    });

    it("lets what it says it's free to take it before any waiter", async () => {
        const gate = new Gate();
        const fold = gate.tryTake("fold");
        /** @type {(() => void) | null} */
        let commit = null;
        gate.onFree = () => {
            gate.onFree = () => {};
            commit = gate.tryTake("edit");
        };
        const turn = gate.take("turn", ["turn"]);
        fold?.();
        expect(gate.holder).toBe("edit");
        await Promise.resolve();
        expect(gate.holder).toBe("edit");
        commit?.();
        expect(await turn).not.toBeNull();
        expect(gate.holder).toBe("turn");
    });

    it("says when it's let go", () => {
        const gate = new Gate();
        const onFree = vi.fn();
        gate.onFree = onFree;
        gate.tryTake("fold")?.();
        expect(onFree).toHaveBeenCalledOnce();
    });
});
