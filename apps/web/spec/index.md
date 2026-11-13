# A short task list

A list that stays short: a few open tasks at most, so one gets done before
another is taken on.

## Story: Keep a short list

> As someone with too much to do, I want to write a task down, tick it off
> and throw it away, and to be stopped from taking on more than three at
> once.

### A list holds open and done tasks, and starts empty

A task is its title.

```quint
type Tasks = { open: Set[str], done: Set[str] }
pure val initial: Tasks = { open: Set(), done: Set() }
```

### No more than three tasks are open at once

```quint
pure val limit = 3
pure def alwaysOpenWithinLimit(l: Tasks): bool = l.open.size() <= limit
```

### A new task needs a title no other task has, and room among the open ones

```quint
pure val titleValues = Set("", "bread", "milk", "eggs", "tea")
pure def canAdd(l: Tasks, title: str): bool =
  title != "" and not(l.open.contains(title)) and not(l.done.contains(title)) and l.open.size() < limit
pure def add(l: Tasks, title: str): Tasks = { ...l, open: l.open.union(Set(title)) }
```

### Only an open task can be completed, and it is then done

```quint
pure def canComplete(l: Tasks, title: str): bool = l.open.contains(title)
pure def complete(l: Tasks, title: str): Tasks =
  { open: l.open.exclude(Set(title)), done: l.done.union(Set(title)) }
```

### Any task on the list can be removed, open or done

```quint
pure def canRemove(l: Tasks, title: str): bool = l.open.contains(title) or l.done.contains(title)
pure def remove(l: Tasks, title: str): Tasks =
  { open: l.open.exclude(Set(title)), done: l.done.exclude(Set(title)) }
```

### No task is both open and done

```quint
pure def alwaysOpenOrDone(l: Tasks): bool = l.open.intersect(l.done).size() == 0
```

### The list can fill up, and everything on it can get done

```quint
pure def sometimesFull(l: Tasks): bool = l.open.size() == limit
pure def sometimesAllDone(l: Tasks): bool = l.open.size() == 0 and l.done.size() == limit
```
