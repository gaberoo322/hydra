import LocalTimestamp from "../LocalTimestamp.jsx";
import Markdown from "./Markdown.jsx";
import ThinkingBlock from "./ThinkingBlock.jsx";
import ToolBlock from "./ToolBlock.jsx";

// Top-level message renderer. Routes between user/assistant/system roles and
// delegates block rendering to ThinkingBlock / ToolBlock / Markdown. Takes a
// `message` prop and returns JSX.

const ROLE_STYLES = {
  user: { label: "user", chip: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" },
  assistant: { label: "assistant", chip: "bg-sky-500/10 text-sky-300 border-sky-500/30" },
  system: { label: "system", chip: "bg-zinc-700/40 text-zinc-300 border-zinc-600" },
};

export default function MessageCard({ message }) {
  const role = ROLE_STYLES[message.role] || ROLE_STYLES.system;
  // Pair each tool_use with the immediately-following tool_result so the
  // expand control shows input AND output together.
  const rendered = [];
  const blocks = Array.isArray(message.blocks) ? message.blocks : [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "tool_use") {
      let result = null;
      if (blocks[i + 1] && blocks[i + 1].type === "tool_result") {
        result = blocks[i + 1];
        i++; // consume the paired result
      }
      rendered.push(<ToolBlock key={i} name={b.name} input={b.input} result={result} />);
    } else if (b.type === "tool_result") {
      // Unpaired tool_result (result without a preceding use in this message).
      rendered.push(<ToolBlock key={i} name="(result)" input={null} result={b} />);
    } else if (b.type === "thinking") {
      rendered.push(<ThinkingBlock key={i} text={b.text} />);
    } else {
      // text — markdown for user/assistant, plain for system.
      rendered.push(
        message.role === "system" ? (
          <div key={i} className="text-xs text-zinc-400 whitespace-pre-wrap break-words">{b.text}</div>
        ) : (
          <Markdown key={i} text={b.text} />
        ),
      );
    }
  }
  return (
    <div className="border border-zinc-800 rounded-lg bg-zinc-900/30 p-3 space-y-1">
      <div className="flex items-center gap-2">
        <span className={`px-1.5 py-0.5 text-[10px] rounded border ${role.chip}`}>{role.label}</span>
        {message.timestamp && (
          <LocalTimestamp ts={message.timestamp} className="text-[10px] text-zinc-600 font-mono" />
        )}
      </div>
      <div className="space-y-1">{rendered}</div>
    </div>
  );
}
