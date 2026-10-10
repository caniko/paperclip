// Vitest 5 exports built-in reporters from its public Node entry point.
// https://github.com/vitest-dev/vitest/blob/v5.0.3/packages/vitest/src/public/node.ts
import { JUnitReporter } from "vitest/node";

// Vitest 5.0.3 exposes writeTasks and stable task IDs. Display titles alone can
// collide for parameterized cases, including when Vitest truncates parameters.
// https://github.com/vitest-dev/vitest/blob/v5.0.3/packages/vitest/src/node/reporters/junit.ts
export default class QualificationJUnitReporter extends JUnitReporter {
  constructor() {
    super({});
  }

  async writeTasks(tasks, filename, fileAbsPath) {
    const identified = tasks.map((task) => {
      if (typeof task.id !== "string" || !task.id) {
        throw new Error("Qualification JUnit task identity is missing");
      }
      // Re-emitting the same task retains the same identity: an occurrence
      // counter would hide duplicate execution from the strict verifier.
      return { ...task, name: `${task.name} [vitest:${task.id}]` };
    });
    return super.writeTasks(identified, filename, fileAbsPath);
  }

  async onTestRunEnd(testModules, ...args) {
    const repeated = [];
    const inspect = (task) => {
      if (task.result?.retryCount > 0 || task.result?.repeatCount > 0) {
        repeated.push(task.id);
      }
      for (const child of task.tasks ?? []) inspect(child);
    };
    for (const module of testModules) inspect(module.task);
    // Preserve the real results before rejecting an unexpected execution retry.
    await super.onTestRunEnd(testModules, ...args);
    if (repeated.length) {
      throw new Error(`Qualification received retried or repeated tasks: ${repeated.join(", ")}`);
    }
  }
}
