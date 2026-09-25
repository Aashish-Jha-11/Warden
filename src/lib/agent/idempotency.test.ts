import { describe, expect, it } from "vitest";
import { idempotencyKey } from "./idempotency";

const base = {
  tenantId: "t1",
  caseId: "c1",
  type: "send_email",
  args: { to: "a@example.com", subject: "Hi" },
  attempt: 0,
};

describe("idempotencyKey", () => {
  it("is stable for identical input", () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey({ ...base }));
  });

  it("ignores key order in args", () => {
    // The same action built by two code paths must not produce two keys.
    const reordered = { ...base, args: { subject: "Hi", to: "a@example.com" } };
    expect(idempotencyKey(reordered)).toBe(idempotencyKey(base));
  });

  it("ignores key order in nested args", () => {
    const a = { ...base, args: { meta: { x: 1, y: 2 }, to: "a@" } };
    const b = { ...base, args: { to: "a@", meta: { y: 2, x: 1 } } };
    expect(idempotencyKey(a)).toBe(idempotencyKey(b));
  });

  it("separates a deliberate retry from an accidental one", () => {
    expect(idempotencyKey({ ...base, attempt: 1 })).not.toBe(idempotencyKey(base));
  });

  it("separates tenants, cases, types and args", () => {
    expect(idempotencyKey({ ...base, tenantId: "t2" })).not.toBe(idempotencyKey(base));
    expect(idempotencyKey({ ...base, caseId: "c2" })).not.toBe(idempotencyKey(base));
    expect(idempotencyKey({ ...base, type: "send_sms" })).not.toBe(idempotencyKey(base));
    expect(idempotencyKey({ ...base, args: { to: "b@" } })).not.toBe(idempotencyKey(base));
  });
});
