#!/usr/bin/env node
import { generateCatalog } from "./catalog.ts";
const [command = "gen", root = process.cwd()] = process.argv.slice(2);
if (command !== "gen") throw new Error("usage: component-stories gen [package directory]");
const catalog = generateCatalog(root);
console.log(`${catalog.components.length} components`);
