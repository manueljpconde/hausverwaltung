import { describe, expect, it } from "vitest";
import { isPending, started } from "./concurrency-test-utils";

describe("isPending (#52 R2)", () => {
  it("offene Promise → true", async () => {
    expect(await isPending(new Promise(() => {}))).toBe(true);
  });
  it("erfüllte Promise → false", async () => {
    expect(await isPending(Promise.resolve(1))).toBe(false);
  });
  it("abgelehnte Promise → false", async () => {
    const p = Promise.reject(new Error("x"));
    p.catch(() => {});
    expect(await isPending(p)).toBe(false);
  });
});

describe("started (#52 R2)", () => {
  it("startet ein lazy Thenable sofort und behält seine Ablehnung", async () => {
    let ran = false;
    const lazy: PromiseLike<never> = { then: (_ok, fail) => { ran = true; return Promise.reject(new Error("lazy")).then(undefined, fail); } };
    const p = started(lazy);
    expect(ran).toBe(true);
    await expect(p).rejects.toThrow("lazy");
  });
});
