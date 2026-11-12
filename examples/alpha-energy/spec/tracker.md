# One project's sheet

Tasks and the people who own them, for one project. The data lives in a Google
Sheet that stays hand-editable, so there are two kinds of writer: the app,
whose edits are guarded, and a person typing in the sheet, whose edits are not.
Task IDs are numbers here (`T-012` is 12) and times are ticks.

## Domain

### Tasks, owners and notes

A task names its owners, the tasks it depends on (its parents) and the tasks
it is related to. Children are the inverse of parents and are never stored.
A note is one message sent to one person.

```quint
import kernel.* from "./kernel"

type Status = DecisionNeeded | ToConfirm | NotStarted | InProgress | Done
type Writer = App | Sheet | Fix | Clock | Notifier
type Task = {
  id: int, status: Status, owners: List[str], parents: List[int], related: List[int], due: int,
  updatedAt: int, updatedBy: str, notifiedAt: int, toldSoon: List[int], toldDue: List[int],
}
type NoteKind = Update | Soon | Today
type Note = { kind: NoteKind, task: int, to: str, version: int, at: int }
type Tracker = { tasks: List[Task], owners: List[str], lastId: int, now: int, sent: List[Note], last: Writer }
```

### A new project has its people and no tasks

```quint
pure val initial: Tracker =
  { tasks: List(), owners: List("liza", "cody", "wes"), lastId: 0, now: 0, sent: List(), last: Clock }
```

### Timing

Owners are told about an edit after 3 quiet ticks. A day is 2 ticks, short
enough for the simulator to live through several. Reminders
go out up to 3 days ahead, and a missed day-of reminder up to 2 days late.

```quint
pure val debounce = 3
pure val ticksPerDay = 2
pure val soonDays = 3
pure val lateDays = 2
pure def today(at: int): int = at / ticksPerDay
```

### What the simulator tries

Four task numbers, the three people and one typo.

```quint
pure val idValues = Set(1, 2, 3, 4)
pure val otherValues = Set(1, 2, 3, 4)
pure val actorValues = Set("liza", "cody", "wes")
pure val ownerValues = Set("liza", "cody", "wes", "lisa")
pure val nameValues = Set("liza", "cody", "wes", "lisa")
```

### Small helpers

```quint
pure def hasTask(s: Tracker, id: int): bool = s.tasks.some(t => t.id == id)
pure def add(xs: List[int], x: int): List[int] = if (xs.includes(x)) xs else xs.append(x)
pure def drop(xs: List[int], x: int): List[int] = xs.select(y => y != x)
pure def addName(xs: List[str], x: str): List[str] = if (xs.includes(x)) xs else xs.append(x)
pure def dropName(xs: List[str], x: str): List[str] = xs.select(y => y != x)
pure def distinctNames(xs: List[str]): List[str] =
  xs.foldl(List(), (acc, x) => if (acc.includes(x)) acc else acc.append(x))
pure def touched(t: Task, actor: str, at: int): Task = { ...t, updatedAt: at, updatedBy: actor }
```

## Story: See what is wrong with the data

> As someone looking after a project, I want every broken link listed with a
> fix, so that hand edits in the sheet do not quietly rot the data.

### Everything a task depends on, however far back

A task that lists itself is reported as its own problem, so self-links are left
out here. The search repeats once per task in the sheet, which is enough to
reach every ancestor.

```quint
pure def parentsOfAll(s: Tracker, ids: List[int]): List[int] =
  s.tasks.select(t => ids.includes(t.id))
    .foldl(List(), (acc, t) => acc.concat(t.parents.select(p => p != t.id and not(acc.includes(p)))))

pure def ancestors(s: Tracker, id: int): List[int] =
  s.tasks.foldl(parentsOfAll(s, List(id)), (acc, t) => acc.concat(parentsOfAll(s, acc).select(p => not(acc.includes(p)))))
```

### The problems of one task

An owner that is not a person in the sheet; a parent or related task that does
not exist; a task that depends on or is related to itself; a dependency that
comes back round; a related link that the other task does not return.

```quint
type Code = UnknownOwner | UnknownParent | UnknownRelated | SelfParent | SelfRelated | Cycle | OneSided
type Problem = { code: Code, task: int, ref: int, name: str }

pure def linksBack(s: Tracker, other: int, id: int): bool =
  s.tasks.some(t => t.id == other and t.related.includes(id))

pure def problemsOf(s: Tracker, t: Task): List[Problem] =
  t.owners.select(o => not(s.owners.includes(o))).listMap(o => { code: UnknownOwner, task: t.id, ref: 0, name: o })
    .concat(t.parents.select(p => p != t.id and not(hasTask(s, p))).listMap(p => { code: UnknownParent, task: t.id, ref: p, name: "" }))
    .concat(t.related.select(r => r != t.id and not(hasTask(s, r))).listMap(r => { code: UnknownRelated, task: t.id, ref: r, name: "" }))
    .concat(if (t.parents.includes(t.id)) List({ code: SelfParent, task: t.id, ref: t.id, name: "" }) else List())
    .concat(if (t.related.includes(t.id)) List({ code: SelfRelated, task: t.id, ref: t.id, name: "" }) else List())
    .concat(if (ancestors(s, t.id).includes(t.id)) List({ code: Cycle, task: t.id, ref: t.id, name: "" }) else List())
    .concat(t.related.select(r => r != t.id and hasTask(s, r) and not(linksBack(s, r, t.id))).listMap(r => { code: OneSided, task: t.id, ref: r, name: "" }))

pure def problems(s: Tracker): List[Problem] =
  s.tasks.foldl(List(), (acc, t) => acc.concat(problemsOf(s, t)))
```

### The warning list is empty exactly when the data is well formed

Well formed, said directly: every owner is a person, every link points at a
task, nothing links to itself, no dependency comes back round, and every
related link is returned.

```quint
pure def wellFormed(s: Tracker): bool =
  s.tasks.every(t => and {
    t.owners.every(o => s.owners.includes(o)),
    t.parents.every(p => hasTask(s, p)),
    t.related.every(r => hasTask(s, r)),
    not(t.parents.includes(t.id)),
    not(t.related.includes(t.id)),
    not(ancestors(s, t.id).includes(t.id)),
    t.related.every(r => linksBack(s, r, t.id)),
  })

pure def alwaysTheWarningListIsTheTruth(s: Tracker): bool =
  (problems(s).length() == 0) iff wellFormed(s)
```

## Story: Edit through the app

> As a team member, I want to change tasks from Slack or the web view and be
> refused when a change would break a link, so that the app never makes the
> data worse.

### An app edit never adds a problem, even to data that is already broken

```quint
pure def sameProblem(a: Problem, b: Problem): bool =
  a.code == b.code and a.task == b.task and a.ref == b.ref and a.name == b.name

pure def addsNoProblem(before: Tracker, after: Tracker): bool =
  val old = problems(before)
  problems(after).every(p => old.some(q => sameProblem(p, q)))

pure def stepAnAppEditNeverAddsAProblem(before: Tracker, after: Tracker): bool =
  after.last == App implies addsNoProblem(before, after)
```

### Only a hand edit can make the data worse

Time passing, notifying and fixing change no link for the worse.

```quint
pure def stepOnlyAHandEditCorrupts(before: Tracker, after: Tracker): bool =
  after.last != Sheet implies addsNoProblem(before, after)
```

### A new task gets a number that was never issued and that nothing points at

Otherwise a dangling link left by a hand edit, or an old message quoting a
deleted task, would attach itself to the new task. Only a known person can
create a task.

```quint
pure def numbersInUse(s: Tracker): List[int] =
  s.tasks.foldl(List(), (acc, t) => acc.append(t.id).concat(t.parents).concat(t.related))

pure def canCreate(s: Tracker, actor: str): bool = s.owners.includes(actor)

pure def create(s: Tracker, actor: str): Tracker =
  val id = nextNumber(numbersInUse(s), s.lastId)
  { ...s, last: App, lastId: id, tasks: s.tasks.append({
    id: id, status: NotStarted, owners: List(), parents: List(), related: List(), due: 0,
    updatedAt: s.now, updatedBy: actor, notifiedAt: -1, toldSoon: List(), toldDue: List(),
  }) }
```

### Task numbers are unique and never above the counter

```quint
pure def alwaysTaskNumbersAreUnique(s: Tracker): bool =
  s.tasks.every(a => s.tasks.select(b => b.id == a.id).length() == 1)

pure def alwaysTheCounterCoversEveryTask(s: Tracker): bool =
  s.lastId >= 0 and s.tasks.every(t => t.id <= s.lastId)
```

### The counter never goes back, and a number is never reissued

```quint
pure def stepTheCounterNeverGoesBack(before: Tracker, after: Tracker): bool =
  after.lastId >= before.lastId

pure def stepANumberIsNeverReissued(before: Tracker, after: Tracker): bool =
  after.tasks.every(t => before.tasks.some(b => b.id == t.id) or t.id > before.lastId)
```

### Status and due date can be changed on any task that exists

```quint
pure def canSetStatus(s: Tracker, id: int, status: Status, actor: str): bool = hasTask(s, id)

pure def setStatus(s: Tracker, id: int, status: Status, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, status: status }, actor, s.now) else t) }

pure def canSetDue(s: Tracker, id: int, due: int, actor: str): bool = hasTask(s, id)

pure def setDue(s: Tracker, id: int, due: int, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, due: due }, actor, s.now) else t) }
```

### An owner added through the app must be a person in the sheet

A typo already sitting in the cell may stay until it is fixed.

```quint
pure def canAddOwner(s: Tracker, id: int, owner: str, actor: str): bool =
  hasTask(s, id) and s.owners.includes(owner)

pure def addOwner(s: Tracker, id: int, owner: str, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, owners: addName(t.owners, owner) }, actor, s.now) else t) }

pure def canRemoveOwner(s: Tracker, id: int, owner: str, actor: str): bool = hasTask(s, id)

pure def removeOwner(s: Tracker, id: int, owner: str, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, owners: dropName(t.owners, owner) }, actor, s.now) else t) }
```

### A parent must exist and must not already depend on the task

```quint
pure def canAddParent(s: Tracker, id: int, other: int, actor: str): bool =
  hasTask(s, id) and hasTask(s, other) and id != other and not(ancestors(s, other).includes(id))

pure def addParent(s: Tracker, id: int, other: int, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, parents: add(t.parents, other) }, actor, s.now) else t) }

pure def canRemoveParent(s: Tracker, id: int, other: int, actor: str): bool = hasTask(s, id)

pure def removeParent(s: Tracker, id: int, other: int, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, parents: drop(t.parents, other) }, actor, s.now) else t) }
```

### Related is written on both tasks at once

```quint
pure def canRelate(s: Tracker, id: int, other: int, actor: str): bool =
  hasTask(s, id) and hasTask(s, other) and id != other

pure def relate(s: Tracker, id: int, other: int, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t =>
    if (t.id == id) touched({ ...t, related: add(t.related, other) }, actor, s.now)
    else if (t.id == other) { ...t, related: add(t.related, id) }
    else t) }

pure def canUnrelate(s: Tracker, id: int, other: int, actor: str): bool =
  hasTask(s, id) and hasTask(s, other) and id != other

pure def unrelate(s: Tracker, id: int, other: int, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t =>
    if (t.id == id) touched({ ...t, related: drop(t.related, other) }, actor, s.now)
    else if (t.id == other) { ...t, related: drop(t.related, id) }
    else t) }
```

### Deleting a task through the app removes every link to it

```quint
pure def canDeleteTask(s: Tracker, id: int): bool = hasTask(s, id)

pure def deleteTask(s: Tracker, id: int): Tracker =
  { ...s, last: App, tasks: s.tasks.select(t => t.id != id)
    .listMap(t => { ...t, parents: drop(t.parents, id), related: drop(t.related, id) }) }
```

### Renaming or removing a person through the app rewrites every cell that names them

A cell the app writes never names the same person twice, even when the new
name was already typed there by hand.

```quint
pure def canRenameOwner(s: Tracker, owner: str, name: str): bool =
  s.owners.includes(owner) and not(s.owners.includes(name))

pure def renameOwner(s: Tracker, owner: str, name: str): Tracker =
  { ...s, last: App,
    owners: s.owners.listMap(o => if (o == owner) name else o),
    tasks: s.tasks.listMap(t => { ...t, owners: distinctNames(t.owners.listMap(o => if (o == owner) name else o)) }) }

pure def canDeleteOwner(s: Tracker, owner: str): bool = s.owners.includes(owner)

pure def deleteOwner(s: Tracker, owner: str): Tracker =
  { ...s, last: App, owners: dropName(s.owners, owner),
    tasks: s.tasks.listMap(t => { ...t, owners: dropName(t.owners, owner) }) }
```

## Story: Edit the sheet by hand

> As someone who lives in spreadsheets, I want to type straight into the
> sheet, typos and all, and have the app accept it and show me what to fix.

### A hand edit is accepted whatever it says

Any name can be typed as an owner, even one that is already there, and any
number as a link. A row can be deleted, which leaves links to it dangling.

```quint
pure def canHandAddOwner(s: Tracker, id: int, name: str): bool = hasTask(s, id)

pure def handAddOwner(s: Tracker, id: int, name: str): Tracker =
  { ...s, last: Sheet, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, owners: t.owners.append(name) }, "sheet", s.now) else t) }

pure def canHandAddParent(s: Tracker, id: int, other: int): bool = hasTask(s, id)

pure def handAddParent(s: Tracker, id: int, other: int): Tracker =
  { ...s, last: Sheet, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, parents: add(t.parents, other) }, "sheet", s.now) else t) }

pure def canHandAddRelated(s: Tracker, id: int, other: int): bool = hasTask(s, id)

pure def handAddRelated(s: Tracker, id: int, other: int): Tracker =
  { ...s, last: Sheet, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, related: add(t.related, other) }, "sheet", s.now) else t) }

pure def canHandDeleteTask(s: Tracker, id: int): bool = hasTask(s, id)

pure def handDeleteTask(s: Tracker, id: int): Tracker =
  { ...s, last: Sheet, tasks: s.tasks.select(t => t.id != id) }

pure def canHandDeleteOwner(s: Tracker, owner: str): bool = s.owners.includes(owner)

pure def handDeleteOwner(s: Tracker, owner: str): Tracker =
  { ...s, last: Sheet, owners: dropName(s.owners, owner) }
```

### A hand edit can leave a problem behind

```quint
pure def sometimesTheDataHasAProblem(s: Tracker): bool = problems(s).length() > 0
```

### A one-click fix removes its problem and adds none

The fix is chosen by its place in the warning list; a place that is not in
the list fixes nothing. A cycle has no automatic fix: a person chooses which link to drop. Every other
problem is fixed by removing the bad link, except a one-sided related link,
which is fixed by adding the link back on the other task.

```quint
pure val noProblem: Problem = { code: Cycle, task: 0, ref: 0, name: "" }

pure def problemAt(s: Tracker, index: int): Problem =
  val found = problems(s)
  if (index >= 0 and index < found.length()) found.nth(index) else noProblem

pure def canFix(s: Tracker, index: int): bool = problemAt(s, index).code != Cycle

pure def fix(s: Tracker, index: int): Tracker =
  val p = problemAt(s, index)
  { ...s, last: Fix, tasks: s.tasks.listMap(t =>
    if (p.code == OneSided and t.id == p.ref) { ...t, related: add(t.related, p.task) }
    else if (t.id != p.task) t
    else if (p.code == UnknownOwner) { ...t, owners: dropName(t.owners, p.name) }
    else if (p.code == UnknownParent or p.code == SelfParent) { ...t, parents: drop(t.parents, p.ref) }
    else if (p.code == UnknownRelated or p.code == SelfRelated) { ...t, related: drop(t.related, p.ref) }
    else t) }

pure def stepAFixRemovesAProblem(before: Tracker, after: Tracker): bool =
  after.last == Fix implies problems(after).length() < problems(before).length()

pure def sometimesAProblemIsFixed(s: Tracker): bool = s.last == Fix and problems(s).length() == 0
```

## Story: Be told what changed and what is due

> As a task owner, I want a message after someone else edits my task, three
> days before it is due and on the day, each of them once.

### Time passes

```quint
pure def tick(s: Tracker): Tracker = { ...s, last: Clock, now: s.now + 1 }
```

### One pass of the notifier sends everything that is due and records that it was sent

An edit is announced to the task's owners who are people in the sheet, except
whoever made it. A reminder goes to every such owner. A task that is done, or
has no due date, gets no reminder.

```quint
pure def knownOwners(s: Tracker, t: Task): List[str] = distinctNames(t.owners.select(o => s.owners.includes(o)))

pure def updateIsDue(t: Task, at: int): bool = editIsDue(t.updatedAt, t.notifiedAt, at, debounce)

pure def reminder(t: Task, at: int): Reminder =
  if (t.status == Done or t.due <= 0) NoReminder
  else reminderFor(t.due - today(at), lateDays, soonDays, t.toldDue.includes(t.due), t.toldSoon.includes(t.due))

pure def notesFor(s: Tracker, t: Task): List[Note] =
  (if (updateIsDue(t, s.now))
     knownOwners(s, t).select(o => o != t.updatedBy).listMap(o => { kind: Update, task: t.id, to: o, version: t.updatedAt, at: s.now })
   else List())
    .concat(if (reminder(t, s.now) == DueSoon) knownOwners(s, t).listMap(o => { kind: Soon, task: t.id, to: o, version: t.due, at: s.now }) else List())
    .concat(if (reminder(t, s.now) == DueToday) knownOwners(s, t).listMap(o => { kind: Today, task: t.id, to: o, version: t.due, at: s.now }) else List())

pure def recorded(t: Task, at: int): Task =
  { ...t,
    notifiedAt: if (updateIsDue(t, at)) t.updatedAt else t.notifiedAt,
    toldSoon: if (reminder(t, at) == DueSoon) t.toldSoon.append(t.due) else t.toldSoon,
    toldDue: if (reminder(t, at) == DueToday) t.toldDue.append(t.due) else t.toldDue }

pure def notify(s: Tracker): Tracker =
  { ...s, last: Notifier,
    sent: s.sent.concat(s.tasks.foldl(List(), (acc, t) => acc.concat(notesFor(s, t)))),
    tasks: s.tasks.listMap(t => recorded(t, s.now)) }
```

### A person named twice in a cell is told once

Discovered by simulation: a name typed twice in an owners cell made the
notifier send that person the same message twice. The notifier now reads each
cell as a set of people.

```quint
pure def alwaysNoOneIsToldTwiceInOnePass(s: Tracker): bool =
  s.tasks.every(t => knownOwners(s, t).every(o => knownOwners(s, t).select(x => x == o).length() == 1))
```

### Owners hear about an edit only after the quiet period

```quint
pure def alwaysAnEditIsAnnouncedAfterTheQuietPeriod(s: Tracker): bool =
  s.sent.every(n => n.kind == Update implies n.at - n.version >= debounce)

pure def sometimesAnOwnerIsToldOfAnEdit(s: Tracker): bool = s.sent.some(n => n.kind == Update)
```

### Nothing is sent twice

An edit is announced once per person per settled version. A reminder is sent
once per person per due date, even if the task is moved away from that date
and back, because the sheet remembers every date already reminded for.

```quint
pure def alwaysNothingIsSentTwice(s: Tracker): bool =
  s.sent.every(a => s.sent.select(b => a.kind == b.kind and a.task == b.task and a.to == b.to and a.version == b.version).length() == 1)
```

### Reminders go out at the right distance from the due date

```quint
pure def alwaysRemindersAreTimely(s: Tracker): bool =
  s.sent.every(n => and {
    n.kind == Today implies (n.version <= today(n.at) and today(n.at) - n.version <= lateDays),
    n.kind == Soon implies (n.version - today(n.at) >= 1 and n.version - today(n.at) <= soonDays),
  })

pure def sometimesAReminderGoesOut(s: Tracker): bool = s.sent.some(n => n.kind == Today)
```

### The bookkeeping never runs ahead of the clock

```quint
pure def alwaysTheBookkeepingIsSane(s: Tracker): bool =
  s.tasks.every(t => t.notifiedAt <= t.updatedAt and t.updatedAt <= s.now)
```
