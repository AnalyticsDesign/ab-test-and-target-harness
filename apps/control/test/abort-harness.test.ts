import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { abortingBindings, settleOrAbort } from "./abort-harness";
import { testEnv } from "./helpers";

const INSERT = "INSERT INTO abort_check (id) VALUES (?)";
const SELECT = "SELECT id FROM abort_check";
const readRow = () => env.DB.prepare(SELECT).first<number>("id");

beforeEach(async () => {
  await env.DB.prepare("CREATE TABLE abort_check (id INTEGER PRIMARY KEY)").run();
});

it("before_mode_does_not_execute_the_call", async () => {
  const { env: wrapped, reached, calls } = abortingBindings(testEnv, { at: 1, mode: "before" });
  const pending = wrapped.DB.prepare(INSERT).bind(1).run();
  expect(await settleOrAbort(pending, reached)).toEqual({ aborted: true });
  expect(await readRow()).toBeNull();
  expect(calls).toEqual([INSERT]);
});

it("after_mode_commits_then_hangs", async () => {
  const { env: wrapped, reached } = abortingBindings(testEnv, { at: 1, mode: "after" });
  const pending = wrapped.DB.prepare(INSERT).bind(1).run();
  expect(await settleOrAbort(pending, reached)).toEqual({ aborted: true });
  expect(await readRow()).toBe(1);
});

it("throw_after_mode_commits_then_throws", async () => {
  const { env: wrapped, reached, calls } = abortingBindings(testEnv, { at: 1, mode: "throw_after" });
  const pending = wrapped.DB.batch([
    wrapped.DB.prepare(INSERT).bind(1),
    wrapped.DB.prepare(SELECT),
  ]);
  await expect(pending).rejects.toThrow("injected after commit");
  await reached;
  expect(await readRow()).toBe(1);
  expect(calls).toEqual([`${INSERT} ;; ${SELECT}`]);
});

it("kv_calls_are_counted_in_the_same_sequence", async () => {
  const { env: wrapped, reached, calls } = abortingBindings(testEnv, null);
  await wrapped.DB.prepare(INSERT).bind(1).run();
  await wrapped.CONFIG_KV.put("abort-test", "value");
  const pending = wrapped.DB.prepare(SELECT).first<number>("id");
  expect(await settleOrAbort(pending, reached)).toEqual({ aborted: false, value: 1 });
  expect(await env.CONFIG_KV.get("abort-test")).toBe("value");
  expect(calls).toEqual([INSERT, "kv.put abort-test", SELECT]);
});
