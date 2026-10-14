// Proves the before_provider_request hook leaks into other providers' payloads.
const ext: any = await import("../extensions/workbuddy.ts");

const handlers: Record<string, Function[]> = {};
const registered: any[] = [];
const pi: any = {
  on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
  registerProvider: (id: string, cfg: any) => { registered.push({ id, cfg }); },
  registerCommand: () => {},
};

await ext.default(pi);
const hook = handlers["before_provider_request"]?.[0];
if (!hook) throw new Error("no before_provider_request handler");

// A totally unrelated provider's payload (grok, deepseek, anything).
const foreign = {
  model: "grok-4.6",
  messages: [
    { role: "developer", content: "You are Grok." },
    { role: "user", content: "hi" },
  ],
  tool_choice: "none",
  tools: [{ type: "function", function: { name: "bash" } }],
};
const before = JSON.stringify(foreign);
hook({ type: "before_provider_request", payload: foreign });
const after = JSON.stringify(foreign);

console.log("foreign payload changed?", before !== after);
if (before !== after) {
  const now = foreign as any;
  console.log("  role[0]:", JSON.parse(before).messages[0].role, "->", now.messages[0].role);
  console.log("  tools kept?", now.tools !== undefined, " tool_choice:", JSON.stringify(now.tool_choice));
  console.log("  msg count:", JSON.parse(before).messages.length, "->", now.messages.length);
  console.log("\nREGRESSION: another provider's request was rewritten.");
  process.exit(1);
}
console.log("OK: foreign provider payload untouched.");
