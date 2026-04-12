# Fix Intraday Scan Result Overwrite Logic

## Problem Summary

When a user runs manual scans during market hours, the current code:
1. Displays correct live results in the UI
2. Calls `/api/scanner/backfill` in the background, which **skips** saving if results already exist for the date
3. Even on first save, backfill **re-runs the scan** with default `ZHU_V1` thresholds instead of saving the actual results the user sees
4. Net effect: user sees Result A, storage gets Result B (or nothing on subsequent scans)

## Solution Overview

**Create a new `/api/scanner/save-session` endpoint** that accepts pre-computed scan results from the frontend and saves them directly. Replace the backfill call in `runScan()` with this new endpoint. The backfill route remains untouched for its original purpose (filling missing historical dates from cron).

This is the minimal fix: one new endpoint, one change in the store, no modifications to existing storage logic.

---

## Step 1: Create `/api/scanner/save-session` endpoint

**New file:** `app/api/scanner/save-session/route.ts`

This endpoint receives the actual scan results from the frontend and saves them to storage, always overwriting any existing session for the same date/direction/mtf.

Schema:
```
POST /api/scanner/save-session
{
  market: 'TW' | 'CN',
  date: string,           // YYYY-MM-DD
  direction: 'long' | 'short',
  multiTimeframeEnabled: boolean,
  results: StockScanResult[],
  scanTime: string,       // ISO timestamp from when the scan ran
}
```

Implementation logic:
1. Validate with zod
2. Build a `ScanSession` object:
   - `id`: `${market}-${direction}-${mtf}-${date}-manual`
   - `sessionType`: `'post_close'` (so it writes to the canonical single-file path that overwrites)
   - All other fields from the request body
3. Call `saveScanSession(session)` — this writes to `scans/{market}/{dir}/{mtf}/{date}.json` which naturally **overwrites** on repeat saves (both Blob `allowOverwrite: true` and filesystem `writeFile` overwrite by default)
4. Return `apiOk({ saved: true, resultCount })`

Key design decisions:
- Use `sessionType: 'post_close'` so the save goes to the canonical path (`{date}.json`) rather than the intraday timestamped path (`intraday/{HHMM}.json`). This means each manual scan overwrites the previous one for the same day — exactly the desired behavior.
- No existence check — always overwrite unconditionally.
- The endpoint does NOT re-run any scan. It is purely a "save these results" operation.

## Step 2: Modify `runScan()` in `store/backtestStore.ts`

**File:** `store/backtestStore.ts`, lines ~676-685

Replace the current backfill call:
```typescript
// CURRENT (broken):
fetch('/api/scanner/backfill', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ market, date: scanDate, direction: dir }),
})
```

With a call to the new save-session endpoint that passes the actual results:
```typescript
// NEW (fixed):
const { scanResults: resultsToSave } = get();
fetch('/api/scanner/save-session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    market,
    date: scanDate,
    direction: dir,
    multiTimeframeEnabled: useMultiTimeframe,
    results: resultsToSave,
    scanTime: new Date().toISOString(),
  }),
})
```

Important: read `resultsToSave` from `get().scanResults` at this point in the flow. By line 676, the combined results are already set into state (line 616). The chip-enrichment fetch (lines 621-641) may not have completed yet, but the core scan results are there. This is acceptable — chip data is supplementary display data, not part of the scan record.

The `.then()` callback remains the same — call `fetchCronDates()` to refresh the date tab list.

## Step 3: No changes needed to `saveScanSession`

The existing `saveScanSession()` in `lib/storage/scanStorage.ts` already handles this correctly:
- When `sessionType` is `'post_close'` (or undefined, which defaults to `'post_close'`), it writes to `scans/{market}/{dir}/{mtf}/{date}.json`
- Blob uses `allowOverwrite: true` (line 29)
- Filesystem uses `writeFile` which overwrites by default (line 64)

No changes needed here.

## Step 4: No changes needed to `loadCronSession` / record tabs

The "record" tab loading path (`loadCronSession` -> `/api/scanner/results` -> `loadScanSession`) reads from `scans/{market}/{dir}/{mtf}/{date}.json`. Since the new save-session endpoint writes to this exact same path, record tabs will automatically show the latest saved scan results.

No changes needed here.

## Step 5: Backfill route remains unchanged

The `/api/scanner/backfill` route keeps its original purpose:
- Used by `autoLoadLatest()` and `backfillHistory()` to fill missing historical dates
- Its "skip if exists" logic is correct for that use case (don't re-scan dates that already have results)
- It only runs with `ZHU_V1` defaults, which is fine for historical backfill

No changes needed here.

---

## Intraday-to-Post-Close Transition

The question of what happens when the cron job runs a post-close scan after the user has done manual scans during the day:

- Manual scans during the day save to `{date}.json` with `sessionType: 'post_close'`
- The cron/backfill job also saves to `{date}.json` with `sessionType: 'post_close'`
- The cron job's "skip if exists" check (`loadScanSession`) will find the manual scan's file and skip — meaning the manual scan result persists as the day's record
- If `force: true` is passed to backfill, it will overwrite with a fresh scan using final closing data

This is acceptable behavior. If a more formal post-close rescan is desired later, the user or cron can pass `force: true` to backfill. But for the stated requirement ("scan now, get results now, next scan overwrites last scan"), the manual save is the final record.

---

## Files Changed

| File | Change |
|------|--------|
| `app/api/scanner/save-session/route.ts` | **NEW** — endpoint to save pre-computed results |
| `store/backtestStore.ts` | ~10 lines changed — replace backfill call with save-session call |

## Files NOT Changed

| File | Reason |
|------|--------|
| `lib/storage/scanStorage.ts` | Already handles overwrite correctly for `post_close` type |
| `app/api/scanner/backfill/route.ts` | Keeps its existing purpose for historical backfill |
| `app/api/scanner/results/route.ts` | Already reads from the correct path |
| `app/api/scanner/chunk/route.ts` | No changes needed — scan execution is correct |

---

## Risk Assessment

**Low risk:**
- Only one existing file is modified (`backtestStore.ts`), and the change is a URL + payload swap
- The new endpoint is simple (validate + save, no business logic)
- Storage overwrite semantics are already built into the existing `saveScanSession` function
- Backfill continues to work as before for its original purpose

**Edge case to consider:**
- If the user switches strategy mid-day and scans again, the new results will overwrite the old ones. This is the desired behavior per requirements.
- Race condition: if two scans fire in quick succession, the last one to complete wins. This is fine — the user wants "latest scan wins."
