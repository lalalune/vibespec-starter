import { Checkbox } from "./Checkbox.tsx";
import { Label } from "./Label.tsx";

export default { title: "Ui/Label", component: Label };

/** A label names the control it wraps, which no value of `children` derived from its type shows. */
export const Default = { args: { children: <><Checkbox />Gift wrap</> } };
