import { registerHooks } from "node:module";

// Exercise the real planner without letting unused execution services hide in
// its startup graph. No timing threshold or mocked implementation is involved.
if (["plan", "check"].includes(process.argv.at(-1))) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (
        /\/server\/src\/(?:services\/(?:companies|projects|agents|agent-lifecycle|routines|heartbeat)|auth\/better-auth)\.[cm]?[jt]s$/.test(
          resolved.url,
        )
      ) {
        throw new Error("Read-only deployment must not load mutation services");
      }
      return resolved;
    },
  });
}
