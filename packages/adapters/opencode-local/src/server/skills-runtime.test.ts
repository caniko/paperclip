import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { execute } from "./execute.js";
import { syncOpenCodeSkills } from "./skills.js";

it("delivers concurrent runs' skills without modifying personal skills or configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-personal-"));
  try {
    const home = path.join(root, "home");
    const personal = path.join(home, ".claude", "skills", "paperclip");
    await fs.mkdir(personal, { recursive: true });
    await fs.writeFile(path.join(personal, "SKILL.md"), "Personal Paperclip skill\n");
    const configHome = path.join(home, ".config");
    await fs.mkdir(path.join(configHome, "opencode"), { recursive: true });
    const configFile = path.join(configHome, "opencode", "opencode.jsonc");
    const policy = '{ // personal policy\n "permissions": [{"action":"shell","effect":"ask"}]\n}\n';
    await fs.writeFile(configFile, policy);
    const command = path.join(root, "opencode");
    await fs.writeFile(
      command,
      `#!${process.execPath}
import fs from "node:fs/promises";
const args = process.argv.slice(2);
const files = args.flatMap((arg, index) => arg === "--file" ? [args[index + 1]] : []);
const skills = await Promise.all(files.map(file => fs.readFile(file, "utf8")));
await fs.writeFile(process.env.PAPERCLIP_TEST_CAPTURE, JSON.stringify({args, files, skills, home: process.env.HOME, config: process.env.XDG_CONFIG_HOME}));
process.stdin.resume();
process.stdin.on("end", () => console.log(JSON.stringify({type:"text",sessionID:process.env.PAPERCLIP_RUN_ID,part:{text:"done"}})));
`,
      { mode: 0o700 },
    );
    const captures = await Promise.all(
      ["one", "two"].map(async (runId) => {
        const source = path.join(root, runId);
        await fs.mkdir(source);
        await fs.writeFile(path.join(source, "SKILL.md"), `Run ${runId} skill\n`);
        const capture = path.join(root, `${runId}.json`);
        const config = {
          command,
          cwd: root,
          model: "fixture/model",
          timeoutSec: 10,
          dangerouslySkipPermissions: false,
          env: {
            HOME: home,
            XDG_CONFIG_HOME: configHome,
            OPENCODE_ALLOW_ALL_MODELS: "1",
            PAPERCLIP_TEST_CAPTURE: capture,
          },
          paperclipRuntimeSkills: [{ key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source }],
        };
        await syncOpenCodeSkills({ config, agentId: "agent", companyId: "company", adapterType: "opencode_local" }, []);
        const result = await execute({
          runId,
          agent: {
            id: "agent",
            companyId: "company",
            name: "OpenCode",
            adapterType: "opencode_local",
            adapterConfig: {},
          },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config,
          context: {},
          onLog: async () => {},
        });
        expect(result.exitCode).toBe(0);
        const delivered = JSON.parse(await fs.readFile(capture, "utf8"));
        expect(delivered.skills).toEqual([`Run ${runId} skill\n`]);
        expect(delivered.home).toBe(home);
        expect(delivered.config).toBe(configHome);
        for (const file of delivered.files) await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
        return delivered;
      }),
    );
    expect(captures[0].files[0]).not.toBe(captures[1].files[0]);
    expect(await fs.readFile(path.join(personal, "SKILL.md"), "utf8")).toBe("Personal Paperclip skill\n");
    expect(await fs.readFile(configFile, "utf8")).toBe(policy);
    expect(await fs.readdir(path.dirname(personal))).toEqual(["paperclip"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
