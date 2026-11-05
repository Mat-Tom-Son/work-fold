import { HISTORY_REVIEW_LIMITS, type HistoryFileComparison, type HistoryFileObservation } from "../../../src/shared/history-review";
import type { HistoryRestorePreview } from "../components/panes/workFolderPanes";

/** What the preview's restore point page shows for one restore point, and its Compare views. */
export interface FixtureRestorePoint {
  preview: HistoryRestorePreview;
  comparisons: Record<string, HistoryFileComparison>;
}

const ideasNow = `# Kitchen refresh

Ideas for the spring kitchen refresh. Keep the layout; change the surfaces.

## Must-haves

- Deeper drawers beside the range
- Under-cabinet lighting on a dimmer
- A pull-out bin for recycling

## Finishes we like

| Area | First choice | Backup |
| --- | --- | --- |
| Cabinets | Sage green, flat panel | Warm white, shaker |
| Counters | Honed quartz | Butcher block |
| Backsplash | Zellige tile | Plain subway tile |

## Estimates

- **Fixed-price quote:** $38,400 with cabinetry included
- **Allowance quote:** $33,900 plus a $6,000 cabinetry allowance

> The allowance quote only wins if the cabinets come in under $4,500.

## Next steps

- [x] Compare the two estimates
- [ ] Ask for the cabinetry allowance in writing
- [ ] Pick a start date that avoids the Japan trip
`;

const ideasThen = `# Kitchen refresh

Ideas for the spring kitchen refresh. Keep the layout; change the surfaces.

## Must-haves

- Deeper drawers beside the range
- Under-cabinet lighting on a dimmer
- A pull-out bin for recycling

## Finishes we like

| Area | First choice | Backup |
| --- | --- | --- |
| Cabinets | Sage green, flat panel | Warm white, shaker |
| Counters | Honed quartz | Butcher block |
| Backsplash | Zellige tile | Plain subway tile |

## Next steps

- [ ] Compare the two estimates
- [ ] Pick a start date that avoids the Japan trip
`;

const weekendChecklist = `# Weekend checklist

## Saturday

- [ ] 9:00 Hardware store: drawer slides, dimmer switch
- [ ] 10:30 Measure the pantry wall for the recycling pull-out
- [ ] 1:00 Garden: plant the tomato starts from [the planting plan](Garden/planting-plan.pdf)
- [ ] 4:00 Call the contractor about the cabinetry allowance

## Sunday

- [ ] Morning off
- [ ] Price the backsplash tile at two shops
- [ ] Update [ideas.md](<Kitchen refresh/ideas.md>) with anything that changes the budget

Leave Sunday afternoon open; the Saturday list is already full.
`;

const itineraryNow = `# Japan trip: a relaxed week

Seven days, two bases, no more than one long train ride.

| Day | Base | Plan |
| --- | --- | --- |
| 1 | Tokyo | Arrive, check in, early dinner near the hotel |
| 2 | Tokyo | Yanaka and Ueno Park; nothing booked after 3 PM |
| 3 | Tokyo | Day trip to Kamakura |
| 4 | Kyoto | Shinkansen at 10:03; afternoon in Higashiyama |
| 5 | Kyoto | Fushimi Inari early, then a slow lunch |
| 6 | Kyoto | Arashiyama; tea in the afternoon |
| 7 | Kyoto | Pack, Nishiki Market, train to the airport |

## Booked

- Hotel in Tokyo, nights 1–3 (see \`Bookings/hotel.pdf\`)
- Kyoto ryokan, nights 4–6

## Still to decide

- Whether to swap Kamakura for Nikko
- A dinner reservation for the last night
`;

const itineraryThen = `# Japan trip

| Day | Base | Plan |
| --- | --- | --- |
| 1 | Tokyo | Arrive, check in |
| 2 | Tokyo | Yanaka, Ueno Park, Asakusa, Akihabara |
| 3 | Tokyo | Day trip to Kamakura |
| 4 | Kyoto | Shinkansen; Higashiyama |
| 5 | Kyoto | Fushimi Inari, Nara |
| 6 | Kyoto | Arashiyama |
| 7 | Kyoto | Fly home |

## Booked

- Hotel in Tokyo, nights 1–3 (see \`Bookings/hotel.pdf\`)
- Kyoto ryokan, nights 4–6
`;

const gardenIdeas = `# Garden ideas

- Raised bed along the south fence
- Drip line on a timer
- Herbs by the back door
`;

/** Text the preview's file tabs show, by work-folder and path. Other files show their type icon. */
export function buildFixtureFileContents(homeId: string, tripId: string): Record<string, Record<string, string>> {
  return {
    [homeId]: { "Kitchen refresh/ideas.md": ideasNow, "Garden/ideas.md": gardenIdeas, "weekend checklist.md": weekendChecklist },
    [tripId]: { "itinerary.md": itineraryNow },
  };
}

/**
 * The preview's restore points: what changed since each one, as the host would
 * report it, with Compare views built from the same before-and-after text.
 */
export function buildFixtureRestorePoints(capturedAt: string, observedAt: string): Record<string, FixtureRestorePoint> {
  const saved = (checkpointId: string, text: string | null): HistoryFileObservation => text === null
    ? { source: "checkpoint", checkpointId, capturedAt, status: "absent" }
    : { source: "checkpoint", checkpointId, capturedAt, status: "text", sizeBytes: new TextEncoder().encode(text).length, text };
  const current = (text: string): HistoryFileObservation => ({ source: "current", observedAt, status: "text", sizeBytes: new TextEncoder().encode(text).length, text });
  const compare = (checkpointId: string, path: string, before: string | null, after: string): HistoryFileComparison => ({
    schemaVersion: 1,
    path,
    before: saved(checkpointId, before),
    after: current(after),
    change: before === null ? "added" : "modified",
    diff: { status: "available", text: unifiedDiff(path, checkpointId, before, after), truncated: false },
    limits: { ...HISTORY_REVIEW_LIMITS },
  });
  return {
    "cp-home-1": {
      preview: {
        checkpointId: "cp-home-1", scope: "full",
        restoreFiles: ["Kitchen refresh/ideas.md"],
        removePaths: ["weekend checklist.md"],
        moves: [{ fromPath: "Garden/planting-plan.pdf", toPath: "planting-plan.pdf" }],
        excludedPaths: [], uncoveredPaths: [], conflicts: [],
      },
      comparisons: {
        "Kitchen refresh/ideas.md": compare("cp-home-1", "Kitchen refresh/ideas.md", ideasThen, ideasNow),
        "weekend checklist.md": compare("cp-home-1", "weekend checklist.md", null, weekendChecklist),
      },
    },
    "cp-trip-1": {
      preview: {
        checkpointId: "cp-trip-1", scope: "full",
        restoreFiles: ["itinerary.md"], removePaths: [], moves: [],
        excludedPaths: [], uncoveredPaths: ["Bookings/hotel.pdf"], conflicts: [],
      },
      comparisons: { "itinerary.md": compare("cp-trip-1", "itinerary.md", itineraryThen, itineraryNow) },
    },
  };
}

/** A unified diff with three lines of context, in the host's format, for the sample texts above. */
function unifiedDiff(path: string, checkpointId: string, before: string | null, after: string): string {
  const left = before === null ? [] : before.split(/(?<=\n)/u);
  const right = after.split(/(?<=\n)/u);
  const table = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] = left[i] === right[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const lines: Array<{ kind: " " | "-" | "+"; text: string }> = [];
  let i = 0; let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { lines.push({ kind: " ", text: left[i++]! }); j += 1; }
    else if (i < left.length && (j === right.length || table[i + 1]![j]! >= table[i]![j + 1]!)) lines.push({ kind: "-", text: left[i++]! });
    else lines.push({ kind: "+", text: right[j++]! });
  }
  const hunks: Array<{ start: number; end: number }> = [];
  lines.forEach((line, index) => {
    if (line.kind === " ") return;
    const start = Math.max(0, index - 3); const end = Math.min(lines.length, index + 4);
    const previous = hunks.at(-1);
    if (previous && start <= previous.end) previous.end = end;
    else hunks.push({ start, end });
  });
  const parts = [`--- ${before === null ? "/dev/null" : JSON.stringify(`a/${path}`)}\t${checkpointId}\n`, `+++ ${JSON.stringify(`b/${path}`)}\tcurrent observation\n`];
  let oldPosition = 0; let newPosition = 0; let cursor = 0;
  for (const hunk of hunks) {
    for (; cursor < hunk.start; cursor += 1) { if (lines[cursor]!.kind !== "+") oldPosition += 1; if (lines[cursor]!.kind !== "-") newPosition += 1; }
    const selected = lines.slice(hunk.start, hunk.end);
    const oldCount = selected.filter((line) => line.kind !== "+").length;
    const newCount = selected.filter((line) => line.kind !== "-").length;
    parts.push(`@@ -${oldPosition + (oldCount ? 1 : 0)},${oldCount} +${newPosition + (newCount ? 1 : 0)},${newCount} @@\n`);
    for (const line of selected) {
      parts.push(line.kind + line.text);
      if (line.kind !== "+") oldPosition += 1;
      if (line.kind !== "-") newPosition += 1;
    }
    cursor = hunk.end;
  }
  return parts.join("");
}
