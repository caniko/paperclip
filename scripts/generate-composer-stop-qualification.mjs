import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, ".github/workflows/pr-trusted.yml");
const output = path.join(root, ".github/workflows/qualification-native-stop.yml");

// Exercise the prepared job before changing the immutable PR caller. Generate
// its commands verbatim so the independent run cannot drift into a weaker lane.
export function renderStopQualification(workflow) {
  const job = workflow.match(/^  native_composer_stop:\n[\s\S]*?(?=^  [a-zA-Z0-9_-]+:|$(?![\s\S]))/m)?.[0];
  if (!job || !job.includes("    needs: [gate]\n") || !job.includes("    timeout-minutes: 20\n")) {
    throw new Error("Cannot identify the prepared native composer Stop job");
  }
  const prepared = job
    .replace("    needs: [gate]\n", "")
    .replace("    if: ${{ needs.gate.outputs.full_ci == 'true' }}\n", "")
    .replace("    runs-on: ${{ needs.gate.outputs.runner }}\n", "    runs-on: ubuntu-24.04\n")
    .trimEnd();
  if (prepared.includes("needs.gate")) throw new Error("Unresolved gate in independent Stop job");
  return `# Generated from the prepared native_composer_stop job.\n# Regenerate: node scripts/generate-composer-stop-qualification.mjs\nname: Independent prepared native composer Stop\n\non:\n  pull_request:\n\npermissions:\n  contents: read\n  actions: read\n  pull-requests: read\n\nconcurrency:\n  group: prepared-native-stop-${"${{ github.event.pull_request.number }}"}-${"${{ github.event.pull_request.head.sha }}"}\n  cancel-in-progress: false\n\njobs:\n${prepared}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const generated = renderStopQualification(readFileSync(source, "utf8"));
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== generated) {
      throw new Error("Independent Stop workflow differs from the prepared job; regenerate it");
    }
  } else {
    writeFileSync(output, generated);
  }
}
