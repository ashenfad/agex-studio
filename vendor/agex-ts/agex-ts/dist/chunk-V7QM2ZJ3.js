// src/errors.ts
var TASK_CONTROL_BRAND = "__agex_task_control__";
function isTaskControlError(e) {
  return typeof e === "object" && e !== null && TASK_CONTROL_BRAND in e && typeof e[TASK_CONTROL_BRAND] === "string";
}
var TaskFailError = class extends Error {
  [TASK_CONTROL_BRAND] = "fail";
  constructor(message) {
    super(message);
    this.name = "TaskFailError";
  }
};
var CancelledError = class extends Error {
  [TASK_CONTROL_BRAND] = "cancelled";
  constructor(message = "Task cancelled") {
    super(message);
    this.name = "CancelledError";
  }
};
function isCancelledError(e) {
  if (e instanceof CancelledError) return true;
  return typeof e === "object" && e !== null && "name" in e && e.name === "CancelledError";
}
var AgentError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentError";
  }
};
var RegistrationError = class extends AgentError {
  constructor(message) {
    super(message);
    this.name = "RegistrationError";
  }
};
var SchemaError = class extends AgentError {
  constructor(message, issues) {
    super(message);
    this.issues = issues;
    this.name = "SchemaError";
  }
  issues;
};
var TransientError = class extends AgentError {
  retryAfterMs;
  constructor(message, opts = {}) {
    super(message);
    this.name = "TransientError";
    if (opts.cause !== void 0) this.cause = opts.cause;
    if (opts.retryAfterMs !== void 0) this.retryAfterMs = opts.retryAfterMs;
  }
};
var FatalError = class extends AgentError {
  constructor(message, opts = {}) {
    super(message);
    this.name = "FatalError";
    if (opts.cause !== void 0) this.cause = opts.cause;
  }
};

export { AgentError, CancelledError, FatalError, RegistrationError, SchemaError, TASK_CONTROL_BRAND, TaskFailError, TransientError, isCancelledError, isTaskControlError };
//# sourceMappingURL=chunk-V7QM2ZJ3.js.map
//# sourceMappingURL=chunk-V7QM2ZJ3.js.map