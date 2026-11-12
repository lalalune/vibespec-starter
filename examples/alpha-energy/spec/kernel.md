# Tracker arithmetic

The small calculations that the tracker's promises rest on: which number a new
row gets, when owners are told about an edit, which reminder is due, and where
a page of a list starts. Whole numbers only. Other specs import this one.

## Story: An ID is never issued twice

> As someone who quotes task IDs in messages, I want an ID to mean one task
> for ever, so that an old message never points at a different task.

### A new number is above the stored counter and above every number seen

`seen` is every number in the table and every number that a link points at,
even a dangling one. `stored` is the highest number ever issued, which is kept
after rows are deleted.

```quint
pure def nextNumber(seen: List[int], stored: int): int =
  seen.foldl(stored, (top, x) => if (x > top) x else top) + 1

pure def lawNextIsAboveTheCounter(seen: List[int], stored: int): bool =
  nextNumber(seen, stored) > stored

pure def lawNextIsAboveEverythingSeen(seen: List[int], stored: int): bool =
  seen.every(x => nextNumber(seen, stored) > x)
```

## Story: Owners hear about an edit once it has settled

> As a task owner, I want to be told about a change after the editing has
> stopped, so that ten quick edits are one message.

### An edit is due when it is unannounced and has been quiet for the whole debounce period

```quint
pure def editIsDue(updatedAt: int, notifiedAt: int, at: int, debounce: int): bool =
  updatedAt > notifiedAt and at - updatedAt >= debounce

pure def lawAnAnnouncedEditIsNeverDue(updatedAt: int, at: int, debounce: int): bool =
  not(editIsDue(updatedAt, updatedAt, at, debounce))

pure def lawAFreshEditIsNotDue(updatedAt: int, notifiedAt: int, debounce: int): bool =
  debounce > 0 implies not(editIsDue(updatedAt, notifiedAt, updatedAt, debounce))
```

## Story: A due date is reminded about once

> As a task owner, I want one reminder three days ahead and one on the day,
> so that I am warned without being nagged.

### At most one reminder is due for a task at a time

`left` is the number of days until the due date; negative means late. A missed
day-of reminder is still sent up to `lateDays` late.

```quint
type Reminder = NoReminder | DueToday | DueSoon

pure def reminderFor(left: int, lateDays: int, soonDays: int, toldDue: bool, toldSoon: bool): Reminder =
  if (left <= 0 and left >= 0 - lateDays and not(toldDue)) DueToday
  else if (left >= 1 and left <= soonDays and not(toldSoon)) DueSoon
  else NoReminder

pure def lawNothingIsRepeated(left: int, lateDays: int, soonDays: int): bool =
  reminderFor(left, lateDays, soonDays, true, true) == NoReminder

pure def lawDueTodayMeansOnOrAfterTheDay(left: int, lateDays: int, soonDays: int, toldDue: bool, toldSoon: bool): bool =
  reminderFor(left, lateDays, soonDays, toldDue, toldSoon) == DueToday implies (left <= 0 and left >= 0 - lateDays)

pure def lawDueSoonMeansAhead(left: int, lateDays: int, soonDays: int, toldDue: bool, toldSoon: bool): bool =
  reminderFor(left, lateDays, soonDays, toldDue, toldSoon) == DueSoon implies (left >= 1 and left <= soonDays)
```

## Story: A list page never comes up empty

> As someone paging through tasks in Slack, I want a stale "next page" button
> to land on the last page, so that I never see an empty list.

### A page starts inside the list

A page number past the end, because the list shrank since the button was
drawn, lands on the last page.

```quint
pure def pageStart(total: int, page: int, pageSize: int): int =
  if (total <= 0 or page <= 0 or pageSize <= 0) 0
  else if (page * pageSize < total) page * pageSize
  else ((total - 1) / pageSize) * pageSize

pure def lawAPageStartsInsideTheList(total: int, page: int, pageSize: int): bool =
  (total > 0 and pageSize >= 1) implies (pageStart(total, page, pageSize) >= 0 and pageStart(total, page, pageSize) < total)

pure def lawAnExistingPageIsNotMoved(total: int, page: int, pageSize: int): bool =
  (page >= 0 and pageSize >= 1 and page * pageSize < total) implies pageStart(total, page, pageSize) == page * pageSize
```

## Story: Only recent requests are accepted

> As the operator, I want a Slack request accepted only if its timestamp is
> close to now, so that a captured request cannot be replayed later.

### A request is fresh within the window, either way

```quint
pure def isFresh(at: int, stamp: int, window: int): bool =
  at - stamp <= window and stamp - at <= window

pure def lawFreshnessIsSymmetric(at: int, stamp: int, window: int): bool =
  isFresh(at, stamp, window) == isFresh(stamp, at, window)
```
