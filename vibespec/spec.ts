#!/usr/bin/env node
// The spec pipeline and command line. Parsing, review, generation, simulation and proof each have one implementation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Model } from "./gen.ts";
import type { Found } from "./conformance.ts";
import { conformance, conformanceFound, writeConformance, type Machine } from "./conform.ts";
