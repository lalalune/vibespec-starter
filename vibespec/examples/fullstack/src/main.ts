// spec/server.md, "Story: Change the list over HTTP"
import { createServer } from "./server.ts";

createServer().listen(3000, () => console.log("http://localhost:3000"));
