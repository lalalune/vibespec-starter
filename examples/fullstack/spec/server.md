# Todo server

The backend: one shared list of to-dos behind an HTTP API. Every request
names the client that sent it and that client's sequence number for it, so a
request that arrives twice, because the client retried after a lost reply,
is recognised. The server answers each request once and remembers the
answer. Every change to the list raises the version by one; clients use the
version to tell an old copy of the list from a newer one.

## Domain

### The server holds the list, its version and a log of every request it answered

```quint
import todo.* from "./todo"

type Answered = { client: str, seq: int, version: int, ok: bool }
type Server = {
  todos: List[{ id: str, title: str, done: bool, deleted: bool }],
  version: int,
  log: List[Answered],
}
```

The to-do record is written out in full rather than as `Todo`, because the
system spec imports this one under a name, and the tools can only follow a
type of an imported machine back to that machine's own types. It is the same
type as `Todo`.

### A new server has an empty list at version 0

```quint
pure val initial: Server = { todos: List(), version: 0, log: List() }
```

### What the simulator tries

Two clients and the first three sequence numbers of each.

```quint
pure val clientValues = Set("a", "b")
pure val seqValues = Set(1, 2, 3)
```

## Story: Change the list over HTTP

> As a client of the API, I want to create, tick off, rename and remove
> to-dos with one request each, so that the browser never has to send the
> whole list.

### A request is answered only once

A request the log already holds is not applied again; the shell repeats the
answer the log records.

```quint
pure def answered(s: Server, client: str, seq: int): bool =
  s.log.some(h => h.client == client and h.seq == seq)

pure def accepted(s: Server, client: str, seq: int): bool =
  s.log.some(h => h.client == client and h.seq == seq and h.ok)
```

### A new request whose edit makes sense is applied, raising the version by one

```quint
pure def allows(s: Server, client: str, seq: int, op: Op): bool =
  not(answered(s, client, seq)) and opAllowed(s.todos, op)

pure def commit(client: str, s: Server, seq: int, op: Op): Server =
  val v = s.version + 1
  { todos: applyOp(s.todos, op), version: v, log: s.log.append({ client: client, seq: seq, version: v, ok: true }) }

pure def canCreate(s: Server, client: str, seq: int, id: str, title: str): bool =
  allows(s, client, seq, { kind: "create", id: id, title: title, done: false })
pure def create(s: Server, client: str, seq: int, id: str, title: str): Server =
  commit(client, s, seq, { kind: "create", id: id, title: title, done: false })

pure def canSetDone(s: Server, client: str, seq: int, id: str, done: bool): bool =
  allows(s, client, seq, { kind: "done", id: id, title: "", done: done })
pure def setDone(s: Server, client: str, seq: int, id: str, done: bool): Server =
  commit(client, s, seq, { kind: "done", id: id, title: "", done: done })

pure def canRename(s: Server, client: str, seq: int, id: str, title: str): bool =
  allows(s, client, seq, { kind: "rename", id: id, title: title, done: false })
pure def rename(s: Server, client: str, seq: int, id: str, title: str): Server =
  commit(client, s, seq, { kind: "rename", id: id, title: title, done: false })

pure def canRemove(s: Server, client: str, seq: int, id: str): bool =
  allows(s, client, seq, { kind: "remove", id: id, title: "", done: false })
pure def remove(s: Server, client: str, seq: int, id: str): Server =
  commit(client, s, seq, { kind: "remove", id: id, title: "", done: false })
```

### A new request can be refused, which is logged and changes nothing else

The shell refuses a request whose edit does not make sense, such as ticking
off a to-do another client has just removed.

```quint
pure def canRefuse(s: Server, client: str, seq: int): bool = not(answered(s, client, seq))
pure def refuse(s: Server, client: str, seq: int): Server =
  { ...s, log: s.log.append({ client: client, seq: seq, version: s.version, ok: false }) }
```

### The version counts the changes

```quint
pure def alwaysTheVersionCountsTheChanges(s: Server): bool =
  s.version == s.log.select(h => h.ok).length()
```

### No request is answered twice

```quint
pure def alwaysNoRequestIsAnsweredTwice(s: Server): bool =
  s.log.every(a => s.log.select(b => b.client == a.client and b.seq == a.seq).length() == 1)
```

### Each request is logged once and raises the version by at most one

```quint
pure def stepEachRequestRaisesTheVersionByAtMostOne(before: Server, after: Server): bool =
  after.log.length() == before.log.length() + 1
    and (after.version == before.version or after.version == before.version + 1)
```

### Two clients can both change the list, and a request can be refused

```quint
pure def sometimesTwoClientsChangedIt(s: Server): bool =
  accepted(s, "a", 1) and s.log.some(h => h.client == "b" and h.ok)

pure def sometimesARefusal(s: Server): bool = s.log.some(h => not(h.ok)) and s.version >= 1
```

## Story: A to-do keeps its id for ever

> As a user who mentions a to-do by its id, I want an id to stand for one
> to-do only, even after it is removed, so that an old link never leads to a
> different to-do.

### No two to-dos share an id

```quint
pure def alwaysIdsAreUnique(s: Server): bool =
  s.todos.every(t => s.todos.select(u => u.id == t.id).length() == 1)
```

### A to-do is never taken out of the list; removing it leaves a tombstone

```quint
pure def stepNoToDoIsForgotten(before: Server, after: Server): bool =
  before.todos.every(t => after.todos.some(u => u.id == t.id))

pure def sometimesATombstone(s: Server): bool = s.todos.some(t => t.deleted)
```

## Story: Other specs can rely on the server's rules

> As the author of a spec that runs the server inside a larger system, I
> want the server's rules stated as laws, so that my proofs can use them
> rather than prove them again.

### Applying or refusing a new request keeps every rule of the server

What is proved about the transitions of a spec cannot be called from a spec
that imports it; a law can.

```quint
pure val sValues =
  Set(initial).union(Set({
    todos: List({ id: "x", title: "milk", done: false, deleted: false }),
    version: 1,
    log: List({ client: "a", seq: 1, version: 1, ok: true }),
  }))
pure val opValues =
  Set({ kind: "create", id: "y", title: "eggs", done: false })
    .union(Set({ kind: "done", id: "x", title: "", done: true }))
    .union(Set({ kind: "remove", id: "x", title: "", done: false }))

pure def rulesHold(s: Server): bool =
  alwaysTheVersionCountsTheChanges(s) and alwaysNoRequestIsAnsweredTwice(s) and alwaysIdsAreUnique(s)

pure def lawACommitKeepsTheRules(s: Server, client: str, seq: int, op: Op): bool =
  (rulesHold(s) and allows(s, client, seq, op)) implies rulesHold(commit(client, s, seq, op))

pure def lawARefusalKeepsTheRules(s: Server, client: str, seq: int): bool =
  (rulesHold(s) and canRefuse(s, client, seq)) implies rulesHold(refuse(s, client, seq))
```
