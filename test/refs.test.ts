import { expect, test } from "bun:test";
import { groupRuns, labelRef } from "../public/refs.js";

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
