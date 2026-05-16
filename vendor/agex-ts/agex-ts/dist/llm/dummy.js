// src/llm/dummy.ts
var DEFAULT_RESPONSES = [
  {
    emissions: [
      {
        type: "ts",
        code: "taskSuccess(null)",
        thinking: "Default Dummy response: succeed with null."
      }
    ]
  }
];
var Dummy = class _Dummy {
  model;
  timeoutSeconds;
  /** Scripted response sequence. */
  responses;
  /** Number of `complete()` calls observed. Useful for tests asserting
   *  that the agent's loop made the expected number of turns. */
  callCount = 0;
  /** Every `system` string the agent passed in, in order. */
  allSystems = [];
  /** Every `turns` array the agent passed in, in order. The first
   *  turn is always the per-task user message. Tests inspect
   *  these to verify what the agent actually saw. */
  allTurns = [];
  constructor(opts = {}) {
    this.model = opts.model ?? "dummy";
    this.timeoutSeconds = opts.timeoutSeconds ?? 60;
    this.responses = opts.responses ?? DEFAULT_RESPONSES;
  }
  // ---------- LLMClient surface ----------
  complete(request, signal) {
    this.allSystems.push(request.system);
    this.allTurns.push([...request.turns]);
    const item = this.responses[this.callCount % this.responses.length];
    this.callCount++;
    if (item instanceof Error) throw item;
    return emissionsToTokens(item, signal);
  }
  dumpConfig() {
    const serializable = this.responses.filter((r) => !(r instanceof Error));
    return {
      provider: "dummy",
      model: this.model,
      timeoutSeconds: this.timeoutSeconds,
      extras: {
        responses: serializable
      }
    };
  }
  static fromConfig(config) {
    const extras = config.extras ?? {};
    return new _Dummy({
      model: config.model,
      timeoutSeconds: config.timeoutSeconds,
      responses: extras.responses ?? DEFAULT_RESPONSES
    });
  }
};
async function* emissionsToTokens(response, signal) {
  const emissions = response.emissions;
  for (let i = 0; i < emissions.length; i++) {
    if (signal?.aborted) return;
    const em = emissions[i];
    yield {
      type: "emission",
      content: emissionContent(em),
      done: true,
      emissionIndex: i,
      emission: em
    };
  }
  yield {
    type: "emission",
    content: "",
    done: true,
    emissionIndex: emissions.length,
    ...response.inputTokens !== void 0 && { inputTokens: response.inputTokens },
    ...response.outputTokens !== void 0 && { outputTokens: response.outputTokens }
  };
}
function emissionContent(em) {
  switch (em.type) {
    case "ts":
      return em.code;
    case "terminal":
      return em.commands;
    case "fileWrite":
      return em.content;
    case "fileEdit":
      return em.content;
    case "text":
      return em.text;
    case "thinking":
      return em.text;
    default: {
      return "";
    }
  }
}

export { Dummy };
//# sourceMappingURL=dummy.js.map
//# sourceMappingURL=dummy.js.map