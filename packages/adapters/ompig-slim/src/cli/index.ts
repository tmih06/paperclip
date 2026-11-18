import { parseOmpigSlimStdoutLine } from "../ui/index.js";
export function printOmpigSlimEvent(line: string, _debug: boolean): void {
  for (const entry of parseOmpigSlimStdoutLine(line, "")) {
    if (entry.kind === "tool_call") console.log("[" + entry.name + "] " + JSON.stringify(entry.input));
    else if (entry.kind === "tool_result") console.log(entry.content);
    else if ("text" in entry) console.log(entry.text);
  }
}
