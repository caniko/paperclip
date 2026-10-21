import { relative } from "node:path";
import { junit } from "node:test/reporters";

/** Preserve Node's raw outcomes/titles while binding each identity to its source file. */
export default async function* sourceJunit(source) {
  async function* boundEvents() {
    for await (const event of source) {
      if ((event.type === "test:pass" || event.type === "test:fail") && typeof event.data.file === "string") {
        yield { ...event, data: { ...event.data, classname: relative(process.cwd(), event.data.file).replaceAll("\\", "/") } };
      } else yield event;
    }
  }
  yield* junit(boundEvents());
}
