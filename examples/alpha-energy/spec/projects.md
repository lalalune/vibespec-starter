# All the projects

The app keeps one thing of its own: the list of projects, each saying which
Google Sheet holds it and which Slack channel talks about it. Everything else
lives in the sheets.

## Domain

### A project entry

```quint
type Writer = Admin | Sheet
type Entry = { key: str, sheet: str, channel: str }
type Registry = { entries: List[Entry], last: Writer }

pure val initial: Registry = { entries: List(), last: Admin }
```

### What the simulator tries

Three project keys, three sheets, two channels, and no channel at all.

```quint
pure val keyValues = Set("a", "b", "c")
pure val sheetValues = Set("S1", "S2", "S3")
pure val channelValues = Set("", "C1", "C2")
```

## Story: Connect a sheet as a project

> As an admin, I want to connect a sheet and a channel as a project, and be
> refused if either already belongs to another project.

### A sheet is connected as at most one project

Two projects writing to one sheet would each issue the same task numbers.

```quint
pure def hasKey(r: Registry, key: str): bool = r.entries.some(e => e.key == key)

pure def channelIsFree(r: Registry, key: str, channel: str): bool =
  channel == "" or r.entries.every(e => e.key == key or e.channel != channel)

pure def canConnect(r: Registry, key: str, sheet: str, channel: str): bool =
  key != "" and sheet != "" and not(hasKey(r, key))
    and r.entries.every(e => e.sheet != sheet) and channelIsFree(r, key, channel)

pure def connect(r: Registry, key: str, sheet: str, channel: str): Registry =
  { entries: r.entries.append({ key: key, sheet: sheet, channel: channel }), last: Admin }

pure def alwaysASheetHasOneProject(r: Registry): bool =
  r.entries.every(a => r.entries.select(b => b.sheet == a.sheet).length() == 1)

pure def alwaysAKeyNamesOneProject(r: Registry): bool =
  r.entries.every(a => r.entries.select(b => b.key == a.key).length() == 1)
```

### A project can be disconnected

```quint
pure def canDisconnect(r: Registry, key: str): bool = hasKey(r, key)

pure def disconnect(r: Registry, key: str): Registry =
  { entries: r.entries.select(e => e.key != key), last: Admin }
```

## Story: Know which project a channel means

> As someone typing `/energy` in a channel, I want the app to act on that
> channel's project, and to ask rather than guess when it cannot tell.

### The admin screen never gives two projects the same channel

```quint
pure def canSetChannel(r: Registry, key: str, channel: str): bool =
  hasKey(r, key) and channelIsFree(r, key, channel)

pure def setChannel(r: Registry, key: str, channel: str): Registry =
  { entries: r.entries.listMap(e => if (e.key == key) { ...e, channel: channel } else e), last: Admin }

pure def sharedChannels(r: Registry): List[str] =
  r.entries.select(a => a.channel != "" and r.entries.some(b => b.key != a.key and b.channel == a.channel))
    .listMap(e => e.channel)

pure def stepTheAdminScreenNeverSharesAChannel(before: Registry, after: Registry): bool =
  after.last == Admin implies sharedChannels(after).every(c => sharedChannels(before).includes(c))
```

### A channel typed into a sheet by hand is accepted, even if another project has it

A project's channel is a cell on its sheet, so a person can type anything.

```quint
pure def canHandSetChannel(r: Registry, key: str, channel: str): bool = hasKey(r, key)

pure def handSetChannel(r: Registry, key: str, channel: str): Registry =
  { entries: r.entries.listMap(e => if (e.key == key) { ...e, channel: channel } else e), last: Sheet }

pure def sometimesTwoProjectsClaimAChannel(r: Registry): bool = sharedChannels(r).length() > 0
```

### The app never guesses which project a shared channel means

It answers with the one project that claims the channel, and with nothing when
none or several do.

```quint
pure def claimants(r: Registry, channel: str): List[Entry] =
  r.entries.select(e => channel != "" and e.channel == channel)

pure def projectFor(r: Registry, channel: str): str =
  if (claimants(r, channel).length() == 1) claimants(r, channel).nth(0).key else ""

pure def lawAnAnswerIsTheOnlyClaimant(r: Registry, channel: str): bool =
  projectFor(r, channel) == "" or claimants(r, channel).every(e => e.key == projectFor(r, channel))

pure val rValues = Set(
  { entries: List(), last: Admin },
  { entries: List({ key: "a", sheet: "S1", channel: "C1" }), last: Admin },
  { entries: List({ key: "a", sheet: "S1", channel: "C1" }, { key: "b", sheet: "S2", channel: "C1" }), last: Sheet },
  { entries: List({ key: "a", sheet: "S1", channel: "C1" }, { key: "b", sheet: "S2", channel: "C2" }), last: Admin },
)
```
