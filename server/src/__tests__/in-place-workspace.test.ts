import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInPlaceWorkspacePath } from "../services/in-place-workspace.js";
import { ensurePersistedExecutionWorkspaceAvailable } from "../services/workspace-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("authoritative workspace preparation", () => {
  it("defers private local path validation to the enrolled authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "in-place-owned-"));
    roots.push(root);
    // This path is visible to the enrolled execution identity, not the controller.
    const cwd = path.join(root, "target-private-directory");
    const environmentConfig = { workspaceRealizationMode: "in_place", filesystemOwnership: {
      authority: "host-authority", principal: "controller", roots: [cwd],
    } };
    await expect(resolveInPlaceWorkspacePath({ driver: "local", environmentConfig, cwd })).resolves.toBe(cwd);
    await expect(fs.stat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(resolveInPlaceWorkspacePath({ driver: "local", cwd,
      environmentConfig: { workspaceRealizationMode: "in_place" },
    })).rejects.toThrow("In-place");
    await expect(resolveInPlaceWorkspacePath({ driver: "local", cwd: "relative", environmentConfig })).rejects.toThrow("absolute");
    await expect(resolveInPlaceWorkspacePath({ driver: "local", cwd,
      environmentConfig: { ...environmentConfig, filesystemOwnership: {} },
    })).rejects.toThrow();
  });

  it("keeps local symlink spelling and rejects missing paths without creating them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "in-place-"));
    roots.push(root);
    const data = path.join(root, "data");
    const alias = path.join(root, "alias ");
    await fs.mkdir(data);
    await fs.writeFile(path.join(data, "personal.txt"), "keep");
    await fs.symlink(data, alias);
    const config = { driver: "local", environmentConfig: { workspaceRealizationMode: "in_place" } };
    await expect(resolveInPlaceWorkspacePath({ ...config, cwd: alias })).resolves.toBe(alias);
    const missing = path.join(root, "missing");
    await expect(resolveInPlaceWorkspacePath({ ...config, cwd: missing })).rejects.toThrow("In-place");
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(data, "personal.txt"), "utf8")).resolves.toBe("keep");
    await expect(resolveInPlaceWorkspacePath({ driver: "local", cwd: missing })).resolves.toBeNull();
  });

  it("retains a remote-only path across persisted reuse without host provisioning", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "in-place-remote-"));
    roots.push(root);
    const remote = `${root}/remote-only/alias/../data `;
    await expect(resolveInPlaceWorkspacePath({
      driver: "ssh", cwd: path.join(root, "controller"),
      environmentConfig: { workspaceRealizationMode: "in_place", remoteWorkspacePath: remote },
    })).resolves.toBe(remote);
    const input = {
      base: { baseCwd: remote, source: "project_primary" as const, projectId: null,
        workspaceId: null, repoUrl: null, repoRef: null },
      workspace: { mode: "shared_workspace", strategyType: "project_primary", cwd: remote,
        providerRef: null, projectId: null, projectWorkspaceId: null, repoUrl: null,
        baseRef: null, branchName: null },
      inPlaceCwd: remote, issue: null, agent: { id: "agent", name: "Maintenance", companyId: "company" },
    };
    await expect(ensurePersistedExecutionWorkspaceAvailable(input)).resolves.toMatchObject({ cwd: remote, created: false });
    await expect(ensurePersistedExecutionWorkspaceAvailable({ ...input,
      workspace: { ...input.workspace, cwd: root },
    })).rejects.toThrow("In-place");
    await expect(ensurePersistedExecutionWorkspaceAvailable({ ...input,
      workspace: { ...input.workspace, strategyType: "git_worktree" },
    })).rejects.toThrow("In-place");
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });
});
