import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: bun scripts/check-js-syntax.mjs <file> ...");
  process.exitCode = 2;
}
for (const file of files) {
  try {
    const result = parseSync(file, readFileSync(file, "utf8"));
    for (const error of result.errors) {
      console.error(`${file}: ${error.message}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`${file}: ${error.message}`);
    process.exitCode = 1;
  }
}
