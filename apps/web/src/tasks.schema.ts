// What the store holds of a list (tasks.vibe). The rules are not in it: `decodeState` checks them on the way in.
import { Schema } from "effect";

export const Saved = Schema.Struct({ open: Schema.Array(Schema.String), done: Schema.Array(Schema.String) });
