import { newestDatesFirst, newestDatesIncludingSelection } from '@/lib/dateDefaults';

describe('newestDatesFirst', () => {
  it('deduplicates and orders navigation dates newest first', () => {
    expect(newestDatesFirst([
      '2026-07-03',
      '2026-06-26',
      '2026-08-14',
      '2026-07-03',
      '2026-08-07',
    ])).toEqual([
      '2026-08-14',
      '2026-08-07',
      '2026-07-03',
      '2026-06-26',
    ]);
  });

  it('applies the limit after sorting', () => {
    expect(newestDatesFirst(['2026-06-26', '2026-08-14', '2026-07-03'], 2))
      .toEqual(['2026-08-14', '2026-07-03']);
  });
});

describe('newestDatesIncludingSelection', () => {
  it('keeps an older out-of-range selection visible without moving it to the front', () => {
    expect(newestDatesIncludingSelection([
      '2026-08-14',
      '2026-08-13',
      '2026-08-12',
      '2026-08-11',
    ], '2026-06-26', 4)).toEqual([
      '2026-08-14',
      '2026-08-13',
      '2026-08-12',
      '2026-06-26',
    ]);
  });

  it('keeps a newer selected date in chronological position', () => {
    expect(newestDatesIncludingSelection([
      '2026-08-13',
      '2026-08-12',
      '2026-08-11',
    ], '2026-08-14', 3)).toEqual([
      '2026-08-14',
      '2026-08-13',
      '2026-08-12',
    ]);
  });
});
