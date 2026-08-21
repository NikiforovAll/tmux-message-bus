// Framing for injected bus messages. Load-bearing (validated live): imperative
// injected text is REFUSED by the harness as prompt-injection; a "peer message"
// label with indented quoted bodies is ACCEPTED — provenance rides on the label
// and the quoting, not on a disclaimer sentence. Every injected body MUST go
// through this. Shared by the Stop and UserPromptSubmit drains so both paths
// frame identically.

function quoteBody(body) {
  // Indent body so it reads as quoted data, never as instructions.
  return String(body ?? "")
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
}

function renderOne(m, i) {
  const subj = m.subject ? ` "${m.subject}"` : "";
  const corr = m.reply_to ? ` (reply to #${m.reply_to})` : "";
  return `${i + 1}. from peer '${m.from_agent}' [${m.kind}]${subj}${corr}, message #${m.id}:\n${quoteBody(m.body)}`;
}

// Build the framed block for a batch of claimed messages. Preamble and reply
// hint are ONE line each: the full etiquette already lives in the /bus skill, so
// the frame carries only what the skill cannot supply per-delivery -- the
// provenance verdict on *these* bodies and the #ids to reply against.
export function frame(messages) {
  const n = messages.length;
  const header = `[tmux-message-bus] ${n} peer message${n === 1 ? "" : "s"}:`;
  const items = messages.map(renderOne).join("\n\n");
  // The footer is kind-aware: a request/delegate leaves the sender blocked, so
  // hand over the reply mechanism; a notify/reply is terminal — offering the
  // command there is what turns idle agents into ack-senders, so say nothing.
  const wantsReply = messages.some((m) => m.kind === "request" || m.kind === "delegate");
  const footer = wantsReply
    ? `\n\nSender awaits your reply: \`bus reply --to-msg <#id> --envelope -\`.`
    : ``;
  return `${header}\n\n${items}${footer}`;
}
