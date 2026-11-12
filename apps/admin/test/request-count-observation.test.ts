import { afterEach, expect, test, vi } from "vitest";
import { waitForObservedQuiet, type ObservedRequest } from "../e2e/request-count-observation";

afterEach(() => vi.useRealTimers());
const write = "http://localhost:3000/api/control/sites/s/audiences/a";
const refresh = "http://localhost:3000/w/w/sites/s/audiences/a?_rsc=one";
const row = (url: string, complete = true): ObservedRequest => ({ url, control: ["http://localhost:8799/me"], complete });

// B246: 未到着の0/0・途中まで届いたspanを静穏と誤認したら落ちる。
test("ブラウザで完了した要求の観測が2秒以上遅れても、両方が到着するまで終わらない", async () => {
  vi.useFakeTimers();
  let rows: ObservedRequest[] = [];
  let finished = false;
  const waiting = waitForObservedQuiet(async () => rows, () => [write, refresh]).then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(3_500);
  expect(finished).toBe(false);
  rows = [row(write)];
  await vi.advanceTimersByTimeAsync(3_500);
  expect(finished).toBe(false);
  rows = [row(write), row(refresh)];
  await vi.advanceTimersByTimeAsync(2_500);
  await waiting;
  expect(finished).toBe(true);
});

test("根のspanが未完了なら、controlの子がまだ増えていなくても待つ", async () => {
  vi.useFakeTimers();
  let complete = false;
  let finished = false;
  const waiting = waitForObservedQuiet(async () => [row(write, complete)], () => [write]).then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(3_500);
  expect(finished).toBe(false);
  complete = true;
  await vi.advanceTimersByTimeAsync(2_500);
  await waiting;
});

test("同じURLが二度送信されたら、二件目の観測も待つ", async () => {
  vi.useFakeTimers();
  let rows = [row(write)];
  let finished = false;
  const waiting = waitForObservedQuiet(async () => rows, () => [write, write]).then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(3_500);
  expect(finished).toBe(false);
  rows = [row(write), row(write)];
  await vi.advanceTimersByTimeAsync(2_500);
  await waiting;
});

test("要求が永久に届かなければ空の成功を返さず期限で失敗する", async () => {
  vi.useFakeTimers();
  const waiting = waitForObservedQuiet(async () => [], () => [write]).then(() => "unexpected success", (error: Error) => error.message);
  await vi.advanceTimersByTimeAsync(30_250);
  expect(await waiting).toMatch(/観測/);
});

test("要求しない窓は0件で静穏になれる", async () => {
  vi.useFakeTimers();
  const waiting = waitForObservedQuiet(async () => []);
  await vi.advanceTimersByTimeAsync(2_250);
  await expect(waiting).resolves.toEqual(expect.any(Number));
});

test("観測SQLの失敗を握りつぶさない", async () => {
  await expect(waitForObservedQuiet(async () => { throw new Error("observability unavailable"); }, () => [write])).rejects.toThrow("observability unavailable");
});
