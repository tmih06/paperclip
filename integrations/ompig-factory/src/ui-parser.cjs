// Dependency-free CJS: the board evaluates this source in its restricted parser worker.
function parseStdoutLine(line, ts) {
  let value;
  try { value = JSON.parse(line); }
  catch { return line.trim() ? [{ kind: "stdout", ts, text: line }] : []; }
  if (value?.type === "ompig.event") {
    const event = value.event;
    if (event?.type === "text") return [{ kind: "assistant", ts, text: String(event.content ?? "") }];
    if (event?.type === "tool_call") return [{ kind: "tool_call", ts, name: String(event.tool ?? "tool"), input: event.input ?? {}, toolUseId: String(event.call_id ?? event.id ?? "") }];
    if (event?.type === "tool_result") return [{ kind: "tool_result", ts, toolUseId: String(event.call_id ?? ""), content: String(event.output ?? ""), isError: false }];
    return [];
  }
  if (value?.type === "ompig.result" && value.receipt?.status === "unanswered") {
    return [{ kind: "stderr", ts, text: String(value.receipt.reason ?? "Agent could not finish the assignment.") }];
  }
  return [];
}
exports.parseStdoutLine = parseStdoutLine;
exports.createStdoutParser = () => {
  const seen = new Set();
  return {
    parseLine(line, ts) {
      let value;
      try { value = JSON.parse(line); } catch { return parseStdoutLine(line, ts); }
      const id = value?.type === "ompig.event" ? value.event?.id : null;
      if (typeof id === "string") {
        if (seen.has(id)) return [];
        seen.add(id);
      }
      return parseStdoutLine(line, ts);
    },
    reset() { seen.clear(); },
  };
};
