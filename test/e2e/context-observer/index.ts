import { Plugin } from "@opencode/plugin";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

// Loaded after the tested plugin. Timing ends before the observer's own history reads.
export default Plugin.define({
  id: "context-probe-observer",
  async setup(ctx) {
    const dir = ctx.options.dir;
    if (typeof dir !== "string") return;
    const instance = `observer-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    let seq = 0;
    await ctx.tool.hook("execute.after", async (event) => {
      const hr = performance.now();
      const history = await ctx.session.context({ sessionID: event.sessionID });
      const caller = history.find((message) => message.id === event.messageID);
      appendFileSync(
        join(dir, `log-${instance}.jsonl`),
        `${JSON.stringify({
          kind: "context-hook-exit",
          instance,
          location: ctx.location.directory,
          seq: seq++,
          at: Date.now(),
          hr,
          sessionID: event.sessionID,
          messageID: event.messageID,
          callID: event.id,
          tool: event.tool,
          status: event.status,
          result: event.status === "completed" ? event.result : undefined,
          caller,
          historyBytes: JSON.stringify(history).length,
        })}\n`,
      );
    });
  },
});
