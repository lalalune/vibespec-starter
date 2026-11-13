// A step driver of the order example (AGENTS.md, "Checking a running program"), copied into a scratch project by the
// selftest. Given `unguarded`, it applies each event without asking its guard, the mistake the traces stage catches.
import readline from "node:readline";
import * as order from "./gen/order.ts";

let s = order.initial;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { event, by } = JSON.parse(line);
  const { type, ...args } = event ? order.parseEvent(event) : {};
  s = !event ? order.initial : process.argv[2] === "unguarded" ? order[type](s, ...Object.values(args)) : order.step(s, { type, ...args }, by);
  console.log(JSON.stringify({ state: s }));
}
