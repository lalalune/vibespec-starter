# Shared to-do system

The whole application: the server, two browser tabs, and the network between
them. Each part is the machine its own spec defines, used here under a name
(`S` for the server, `C` for a client); this spec adds the network and the
rules that only the whole system can state. The network may lose, repeat
and reorder messages, and a tab may go offline at any time.

## Domain

### Messages

A client sends a request carrying one of its queued edits. The server
answers the sender with an acknowledgement or a refusal, and tells the other
client when the list changed. Every answer carries the list and its version.
`client` is the sender of a request and the receiver of everything else.

```quint
import server as S from "./server"
import client as C from "./client"
import todo.* from "./todo"

type MsgKind = Request | Ack | Refusal | Push
type Msg = { kind: MsgKind, client: str, seq: int, op: Op, version: int, todos: List[Todo] }
type Cut = { out: List[Msg], k: int }
```

### The system holds the server, clients a and b, the messages in flight, and the history of the list

`history` is not part of the running application: it records the list as it
was at every version, so that rules can say which version a copy is.

```quint
type System = { server: S::Server, a: C::Client, b: C::Client, net: List[Msg], history: List[List[Todo]] }

pure val initial: System =
  { server: S::initial, a: C::initial, b: C::initial, net: List(), history: List(List()) }
```

### What the simulator tries

Both clients, the first few positions in the network, and five edits.

```quint
pure val whoValues = Set("a", "b")
pure val iValues = Set(0, 1, 2)
pure val opValues =
  Set({ kind: "create", id: "x", title: "milk", done: false })
    .union(Set({ kind: "create", id: "y", title: "eggs", done: false }))
    .union(Set({ kind: "done", id: "x", title: "", done: true }))
    .union(Set({ kind: "rename", id: "y", title: "bread", done: false }))
    .union(Set({ kind: "remove", id: "x", title: "", done: false }))
```

### Helpers

```quint
pure def clientOf(sys: System, who: str): C::Client = if (who == "a") sys.a else sys.b
pure def withClient(who: str, c: C::Client, sys: System): System =
  if (who == "a") { ...sys, a: c } else { ...sys, b: c }
pure def other(who: str): str = if (who == "a") "b" else "a"

pure val noOp: Op = { kind: "create", id: "", title: "", done: false }
pure val noMsg: Msg = { kind: Push, client: "", seq: 0, op: noOp, version: -1, todos: List() }
pure def msgAt(net: List[Msg], i: int): Msg = if (i >= 0 and i < net.length()) net.nth(i) else noMsg
pure val uncut: Cut = { out: List(), k: 0 }
pure def dropAt(net: List[Msg], i: int): List[Msg] =
  net.foldl(uncut, (acc, m) => { out: if (acc.k == i) acc.out else acc.out.append(m), k: acc.k + 1 }).out

pure def request(who: str, p: C::Pending): Msg =
  { kind: Request, client: who, seq: p.seq, op: p.op, version: 0, todos: List() }
pure def answer(kind: MsgKind, who: str, seq: int, s: S::Server): Msg =
  { kind: kind, client: who, seq: seq, op: noOp, version: s.version, todos: s.todos }
pure def pastAt(h: List[List[Todo]], v: int): List[Todo] = if (v >= 0 and v < h.length()) h.nth(v) else List()
pure def isPast(h: List[List[Todo]], v: int, todos: List[Todo]): bool =
  v >= 0 and v < h.length() and sameTodos(pastAt(h, v), todos)
```

## Story: Edit together, online or not

> As one of two people sharing a list, I want my edits to reach the server
> whenever I am online, and to be sent again until the server has answered,
> so that nothing I do is lost on a bad connection.

### A user edit is queued in the tab, and sent at once if the tab is online

```quint
pure def canAct(sys: System, who: str, op: Op): bool = opAllowed(C::view(clientOf(sys, who)), op)
pure def act(sys: System, who: str, op: Op): System =
  val c = clientOf(sys, who)
  val queued = C::queue(op, c)
  val sent = if (c.online) sys.net.append(request(who, { seq: queued.made, op: op })) else sys.net
  withClient(who, queued, { ...sys, net: sent })
```

### A tab can go offline, and sends its whole queue again when it comes back

```quint
pure def canGoOffline(sys: System, who: str): bool = C::canGoOffline(clientOf(sys, who))
pure def goOffline(sys: System, who: str): System = withClient(who, C::goOffline(clientOf(sys, who)), sys)

pure def canGoOnline(sys: System, who: str): bool = C::canGoOnline(clientOf(sys, who))
pure def goOnline(sys: System, who: str): System =
  val c = clientOf(sys, who)
  withClient(who, C::goOnline(c), { ...sys, net: sys.net.concat(c.pending.listMap(p => request(who, p))) })
```

### An online tab may send any queued edit again

```quint
pure def canResend(sys: System, who: str, i: int): bool =
  clientOf(sys, who).online and i >= 0 and i < clientOf(sys, who).pending.length()
pure def queuedAt(c: C::Client, i: int): C::Pending =
  if (i >= 0 and i < c.pending.length()) c.pending.nth(i) else { seq: 0, op: noOp }
pure def resend(sys: System, who: str, i: int): System =
  { ...sys, net: sys.net.append(request(who, queuedAt(clientOf(sys, who), i))) }
```

## Story: The server answers every request once

> As the operator, I want the server to apply each edit once however often it
> arrives, to tell the other tab about every change, and to answer a repeated
> request the way it answered the first time.

### The server takes any request off the network and answers it

A request it has answered before gets the same kind of answer again. A new
request is applied if its edit makes sense and refused otherwise. A change
is pushed to the other tab.

```quint
pure def repeatAnswer(m: Msg, rest: List[Msg], sys: System): System =
  { ...sys, net: rest.append(answer(if (S::accepted(sys.server, m.client, m.seq)) Ack else Refusal, m.client, m.seq, sys.server)) }

pure def applyRequest(m: Msg, rest: List[Msg], sys: System): System =
  val s = S::commit(m.client, sys.server, m.seq, m.op)
  { ...sys, server: s, history: sys.history.append(s.todos),
    net: rest.append(answer(Ack, m.client, m.seq, s)).append(answer(Push, other(m.client), 0, s)) }

pure def refuseRequest(m: Msg, rest: List[Msg], sys: System): System =
  { ...sys, server: S::refuse(sys.server, m.client, m.seq), net: rest.append(answer(Refusal, m.client, m.seq, sys.server)) }

pure def canServe(sys: System, i: int): bool = msgAt(sys.net, i).kind == Request and i >= 0 and i < sys.net.length()
pure def serve(sys: System, i: int): System =
  val m = msgAt(sys.net, i)
  val rest = dropAt(sys.net, i)
  if (S::answered(sys.server, m.client, m.seq)) repeatAnswer(m, rest, sys)
  else if (S::allows(sys.server, m.client, m.seq, m.op)) applyRequest(m, rest, sys)
  else refuseRequest(m, rest, sys)
```

### An online tab takes any answer off the network

```quint
pure def receive(m: Msg, c: C::Client): C::Client =
  if (m.kind == Ack) C::receiveAck(c, m.seq, m.version, m.todos)
  else if (m.kind == Refusal) C::receiveRefusal(c, m.seq, m.version, m.todos)
  else C::receiveSnapshot(c, m.version, m.todos)

pure def canDeliver(sys: System, i: int): bool =
  val m = msgAt(sys.net, i)
  i >= 0 and i < sys.net.length() and m.kind != Request and clientOf(sys, m.client).online
pure def deliver(sys: System, i: int): System =
  val m = msgAt(sys.net, i)
  withClient(m.client, receive(m, clientOf(sys, m.client)), { ...sys, net: dropAt(sys.net, i) })
```

### The network may lose or repeat any message

```quint
pure def canLose(sys: System, i: int): bool = i >= 0 and i < sys.net.length()
pure def lose(sys: System, i: int): System = { ...sys, net: dropAt(sys.net, i) }

pure def canDuplicate(sys: System, i: int): bool = i >= 0 and i < sys.net.length()
pure def duplicate(sys: System, i: int): System = { ...sys, net: sys.net.append(msgAt(sys.net, i)) }
```

## Story: Everyone ends up seeing the same list

> As one of two people sharing a list, I want to see a list the server
> really had, never a mix of versions, and once the network is quiet I want
> to see the same list as the other person.

### The server and both tabs keep their own rules

```quint
pure def alwaysEachPartKeepsItsRules(sys: System): bool = and {
  S::alwaysTheVersionCountsTheChanges(sys.server),
  S::alwaysNoRequestIsAnsweredTwice(sys.server),
  S::alwaysIdsAreUnique(sys.server),
  C::alwaysEveryQueuedEditWasNumberedHere(sys.a),
  C::alwaysQueuedEditsHaveDistinctNumbers(sys.a),
  C::alwaysTheEditCountIsNotNegative(sys.a),
  C::alwaysTheConfirmedVersionIsNotNegative(sys.a),
  C::alwaysEveryQueuedEditWasNumberedHere(sys.b),
  C::alwaysQueuedEditsHaveDistinctNumbers(sys.b),
  C::alwaysTheEditCountIsNotNegative(sys.b),
  C::alwaysTheConfirmedVersionIsNotNegative(sys.b),
}
```

### No tab is ahead of the server

```quint
pure def alwaysNoTabIsAheadOfTheServer(sys: System): bool =
  sys.a.seen <= sys.server.version and sys.b.seen <= sys.server.version
```

### The history holds the list at every version up to the current one

```quint
pure def alwaysTheHistoryEndsWithTheCurrentList(sys: System): bool =
  sys.history.length() == sys.server.version + 1
    and sameTodos(pastAt(sys.history, sys.server.version), sys.server.todos)
```

### A tab's confirmed copy is the list exactly as it was at the version the tab has seen

The same holds for every copy on the network.

```quint
pure def alwaysEveryCopyIsTheListAtItsVersion(sys: System): bool =
  isPast(sys.history, sys.a.seen, sys.a.confirmed)
    and isPast(sys.history, sys.b.seen, sys.b.confirmed)
    and sys.net.every(m => m.kind == Request or isPast(sys.history, m.version, m.todos))
```

### Once both tabs have edited and heard every answer, they see the same list as the server

```quint
pure def sometimesBothTabsAgree(sys: System): bool = and {
  sys.a.made >= 1, sys.b.made >= 1,
  sys.a.pending.length() == 0, sys.b.pending.length() == 0,
  sys.a.seen == sys.server.version, sys.b.seen == sys.server.version,
  sameTodos(C::view(sys.a), C::view(sys.b)),
  sameTodos(C::view(sys.a), sys.server.todos),
}
```

### A tab can queue edits while offline, and an edit can be refused

```quint
pure def sometimesQueuedOffline(sys: System): bool = not(sys.a.online) and sys.a.pending.length() >= 2
pure def sometimesARefusedEdit(sys: System): bool = sys.a.refusals + sys.b.refusals >= 1
```
