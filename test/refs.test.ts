import { expect, test } from "bun:test";
import { editRun, groupRuns, labelRef } from "../public/refs.js";

const rec = (ref: string, color = "yellow") => ({ ref, color });
const labels = (rs: { ref: string; color: string }[]) => groupRuns(rs, (r) => r.color).map((g) => labelRef(g.ref));

test("back-to-back verses in one color join into a range", () => {
  expect(labels([rec("ROM.5.3"), rec("ROM.5.4"), rec("ROM.5.5")])).toEqual(["Romans 5:3–5"]);
});

test("a gap, a color change, or a new chapter starts a new row", () => {
  expect(labels([rec("ROM.5.3"), rec("ROM.5.5")])).toEqual(["Romans 5:3", "Romans 5:5"]);
  expect(labels([rec("ROM.5.3"), rec("ROM.5.4", "blue")])).toEqual(["Romans 5:3", "Romans 5:4"]);
  expect(labels([rec("ROM.5.21"), rec("ROM.6.1")])).toEqual(["Romans 5:21", "Romans 6:1"]);
  expect(labels([rec("JUD.1.25"), rec("REV.1.1")])).toEqual(["Jude 1:25", "Revelation 1:1"]);
});

test("a run keeps every record so recolor and delete reach each verse", () => {
  const [run] = groupRuns([rec("JHN.3.16"), rec("JHN.3.17")], (r) => r.color);
  expect(run.records.map((r) => r.ref)).toEqual(["JHN.3.16", "JHN.3.17"]);
});

const hl = (ref: string, color = "yellow", created = 1) => ({ kind: "highlight", ref, highlights: [{ color, created, quote: `q ${ref}` }] });

test("editing Romans 5:3-5 to 5:3-6 keeps 3-5 untouched and adds 6 in the run's color", () => {
  const run = [hl("ROM.5.3"), hl("ROM.5.4"), hl("ROM.5.5")];
  const out = editRun(run, ["ROM.5.3", "ROM.5.4", "ROM.5.5", "ROM.5.6"], "yellow", 50);
  expect(out).toEqual([{ kind: "highlight", ref: "ROM.5.6", highlights: [{ color: "yellow", created: 50 }] }]);
});

test("editing a run to John 3:16 tombstones the old verses and creates the new one", () => {
  const run = [hl("ROM.5.3", "blue"), hl("ROM.5.4", "blue"), hl("ROM.5.5", "blue")];
  const out = editRun(run, ["JHN.3.16"], "blue", 50);
  expect(out).toEqual([
    { kind: "highlight", ref: "ROM.5.3", deleted: true },
    { kind: "highlight", ref: "ROM.5.4", deleted: true },
    { kind: "highlight", ref: "ROM.5.5", deleted: true },
    { kind: "highlight", ref: "JHN.3.16", highlights: [{ color: "blue", created: 50 }] },
  ]);
});

test("shrinking a run tombstones only the verses it drops", () => {
  const out = editRun([hl("ROM.5.3"), hl("ROM.5.4"), hl("ROM.5.5")], ["ROM.5.4"], "yellow", 50);
  expect(out.map((r) => [r.ref, "deleted" in r])).toEqual([["ROM.5.3", true], ["ROM.5.5", true]]);
});

test("the same verses change nothing", () => {
  expect(editRun([hl("JHN.3.16")], ["JHN.3.16"], "yellow", 50)).toEqual([]);
});

test("a new verse already highlighted elsewhere takes the run's color and keeps when it was first saved", () => {
  const existing = hl("ROM.5.6", "green", 7);
  const out = editRun([hl("ROM.5.5")], ["ROM.5.5", "ROM.5.6"], "yellow", 50, (v) => (v === "ROM.5.6" ? existing : null));
  expect(out).toEqual([{ kind: "highlight", ref: "ROM.5.6", highlights: [{ color: "yellow", created: 7, edited: 50 }] }]);
});
