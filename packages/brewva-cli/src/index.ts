#!/usr/bin/env node
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runEdgeOperation } from "@brewva/brewva-effect";
import {
  assertSupportedRuntime,
  parseArgs,
  printStartupError,
  runCliRootEffect,
  runCliRootOperation,
} from "./entry/main.js";

const isBunMain = (import.meta as ImportMeta & { main?: boolean }).main;
const isNodeMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isBunMain ?? isNodeMain) {
  assertSupportedRuntime();
  void runEdgeOperation("brewva.cli.root", runCliRootEffect(), {
    fields: {
      command: process.argv[2] ?? "default",
    },
  }).catch((error) => {
    printStartupError(error);
    process.exitCode = 1;
  });
}

export { parseArgs, runCliRootEffect, runCliRootOperation };
