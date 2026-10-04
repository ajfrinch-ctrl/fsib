/* A clock a booted app can be handed.

   The dashboard's four strips — today, this week, this month, the last 30 days —
   are cut from the wall clock, so a test that seeds a day dated 2026-09-14 and
   asserts what "this month" says passes while September lasts and fails from the
   first of October onwards. Those tests pin the day the app believes it is
   instead of moving their fixtures, so the labels the statement rows carry
   ("21 Sep") stay the ones the assertions name:

     bootOffline({ records: [...], now: FIXTURE_DAY })

   Only the page's own Date is replaced. setTimeout, the waits in these files and
   the test runner keep running on real time, so a debounce still debounces and
   a backoff still backs off — a pinned date is not a pause. */
export const FIXTURE_DAY = "2026-09-24T10:00:00";

export function pinClock(window, iso = FIXTURE_DAY) {
  const Real = window.Date;
  const fixed = new Real(iso).getTime();
  if (!Number.isFinite(fixed)) throw new Error("pinClock: not a date: " + iso);
  /* Asked for "now" it answers the pinned moment; given an argument it is a
     plain Date, because the day a record was saved on still has to parse. */
  function PinnedDate(...args) {
    return args.length ? new Real(...args) : new Real(fixed);
  }
  PinnedDate.prototype = Real.prototype;
  PinnedDate.now = () => fixed;
  PinnedDate.parse = (value) => Real.parse(value);
  PinnedDate.UTC = (...parts) => Real.UTC(...parts);
  window.Date = PinnedDate;
}
