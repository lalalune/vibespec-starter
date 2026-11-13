# Todo server

The backend: one shared list of to-dos behind an HTTP API. Every request
names the client that sent it and that client's sequence number for it, so a
request that arrives twice, because the client retried after a lost reply,
is recognised, provided it carries the same edit. The server answers each
request once and remembers the answer and the edit it answered. Every
accepted edit raises the version by one, even if it leaves the list unchanged;
clients use the version to tell an old copy of the list from a newer one.

## Domain

### The server holds the list, its version and a log of every request it answered

Each entry of the log records the client, the number, the edit the request
carried and whether it was accepted, so that a later request with the same
number can be told apart from a retry.

```quint
import todo.* from "./todo"

type Answered = { client: str, seq: int, op: Op, ok: bool }
type Server = {
  todos: List[Todo],
  version: int,
  log: List[Answered],
}
```

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

### The log tells which requests were answered, and with which edit each was accepted

A request the log already holds is not applied again. It is a retry only if
it carries the edit the log records for its client and number: the shell
answers it as accepted only if that edit was accepted, and refuses a request
that reuses a number for a different edit.

```quint
pure def answered(s: Server, client: str, seq: int): bool =
  s.log.some(h => h.client == client and h.seq == seq)

pure def acceptedAs(s: Server, client: str, seq: int, op: Op): bool =
  s.log.some(h => h.client == client and h.seq == seq and h.ok and sameOp(h.op, op))
```

### A new request whose edit makes sense is applied, raising the version by one

New means the log holds no request with its client and number. The request is
logged as accepted, with its edit.

```quint
pure def allows(s: Server, client: str, seq: int, op: Op): bool =
  not(answered(s, client, seq)) and opAllowed(s.todos, op)

pure def commit(client: str, s: Server, seq: int, op: Op): Server =
  val v = s.version + 1
  { todos: applyOp(s.todos, op), version: v, log: s.log.append({ client: client, seq: seq, op: op, ok: true }) }

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

### A new request can be refused, which is logged with its edit and changes nothing else

For a well-formed new request, the HTTP shell applies an allowed edit and
otherwise refuses it, such as ticking off a to-do another client has just
removed. The model permits refusing any unanswered request; choosing between
application and refusal belongs to the shell. A client cannot ask for refusal.

```quint
pure def canRefuse(s: Server, client: str, seq: int, op: Op): bool = not(answered(s, client, seq))
pure def refuse(s: Server, client: str, seq: int, op: Op): Server =
  { ...s, log: s.log.append({ client: client, seq: seq, op: op, ok: false }) }
```

### The version counts the changes

A change here means one accepted edit, including setting a field to its
current value. Refused requests and retries do not increment the version.

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

### Two clients can both change the list, and a server that has accepted a change can also hold a refusal

The refusal is asked of a server that has also accepted an edit, before or
after it, so that it is not witnessed by a server that only ever refuses.

```quint
pure def sometimesTwoClientsChangedIt(s: Server): bool =
  s.log.some(h => h.client == "a" and h.ok) and s.log.some(h => h.client == "b" and h.ok)

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

### A to-do is never taken out of the list, and a removed one stays removed

```quint
pure def stepNoToDoIsForgotten(before: Server, after: Server): bool =
  before.todos.every(t => after.todos.some(u => u.id == t.id and (u.deleted or not(t.deleted))))
```

### A to-do can be removed, leaving a tombstone

```quint
pure def sometimesATombstone(s: Server): bool = s.todos.some(t => t.deleted)
```

## Story: Other specs can rely on the server's rules

> As the author of a spec that runs the server inside a larger system, I
> want the server's state invariants stated as laws, so that my proofs can
> use them rather than prove them again.

### Applying or refusing a new request keeps the server's state invariants

For these laws, the server's rules are its three state invariants: the version
counts accepted edits, requests are logged once, and to-do ids are unique.
Step and reachability rules are checked separately. What is proved about
imported transitions can be called when their obligations were proved in
the same run. These laws also cover helpers such as `commit`, which are not
transitions.

```quint
pure val sValues =
  Set(initial).union(Set({
    todos: List({ id: "x", title: "milk", done: false, deleted: false }),
    version: 1,
    log: List({ client: "a", seq: 1, op: { kind: "create", id: "x", title: "milk", done: false }, ok: true }),
  }))
pure val opValues =
  Set({ kind: "create", id: "y", title: "eggs", done: false })
    .union(Set({ kind: "done", id: "x", title: "", done: true }))
    .union(Set({ kind: "remove", id: "x", title: "", done: false }))

pure def rulesHold(s: Server): bool =
  alwaysTheVersionCountsTheChanges(s) and alwaysNoRequestIsAnsweredTwice(s) and alwaysIdsAreUnique(s)

pure def lawACommitKeepsTheRules(s: Server, client: str, seq: int, op: Op): bool =
  (rulesHold(s) and allows(s, client, seq, op)) implies rulesHold(commit(client, s, seq, op))

pure def lawARefusalKeepsTheRules(s: Server, client: str, seq: int, op: Op): bool =
  (rulesHold(s) and canRefuse(s, client, seq, op)) implies rulesHold(refuse(s, client, seq, op))
```
