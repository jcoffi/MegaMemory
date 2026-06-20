import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadInstaller(configDir: string): Promise<typeof import("../install.js")> {
  vi.resetModules();
  vi.stubEnv("OPENCODE_CONFIG_DIR", configDir);
  return import("../install.js");
}

describe("install instruction refresh", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("replaces legacy instruction sections and refreshes provenance commands", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-install-"));
    const agentsPath = path.join(configDir, "AGENTS.md");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      agentsPath,
      [
        "# User Notes",
        "",
        "## Project Knowledge Graph",
        "old knowledge graph instructions",
        "",
        "## Personal Notes",
        "keep this section",
        "",
      ].join("\n")
    );

    try {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runInstall } = await loadInstaller(configDir);

      await runInstall(["--target", "opencode"]);

      const agents = fs.readFileSync(agentsPath, "utf-8");
      expect(agents).toContain("<!-- megamemory:instructions begin");
      expect(agents).toContain("MegaMemory instruction version:");
      expect(agents).toContain("informed_by");
      expect(agents).toContain("Node status values: open, validated, refuted, superseded, abandoned");
      expect(agents).not.toContain("old knowledge graph instructions");
      expect(agents).toContain("## Personal Notes\nkeep this section");

      const bootstrapCommand = fs.readFileSync(
        path.join(configDir, "commands", "bootstrap-memory.md"),
        "utf-8"
      );
      const saveCommand = fs.readFileSync(
        path.join(configDir, "commands", "save-memory.md"),
        "utf-8"
      );
      for (const command of [bootstrapCommand, saveCommand]) {
        expect(command).toContain("informed_by");
        expect(command).toContain("status");
        expect(command).toContain("abandoned");
      }
    } finally {
      fs.rmSync(configDir, { force: true, recursive: true });
    }
  });

  it("refreshes existing marker blocks without duplicating instructions", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-install-"));
    const agentsPath = path.join(configDir, "AGENTS.md");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      agentsPath,
      [
        "# User Notes",
        "keep before",
        "",
        "<!-- megamemory:instructions begin old-version -->",
        "## Project Knowledge Graph",
        "old versioned knowledge graph instructions",
        "<!-- megamemory:instructions end -->",
        "",
        "## Personal Notes",
        "keep after",
        "",
      ].join("\n")
    );

    try {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runInstall } = await loadInstaller(configDir);

      await runInstall(["--target", "opencode"]);

      const agents = fs.readFileSync(agentsPath, "utf-8");
      expect(agents).toContain("# User Notes\nkeep before");
      expect(agents).toContain("## Personal Notes\nkeep after");
      expect(agents).toContain("MegaMemory instruction version:");
      expect(agents).toContain("informed_by");
      expect(agents).not.toContain("old-version");
      expect(agents).not.toContain("old versioned knowledge graph instructions");
      expect(agents.match(/<!-- megamemory:instructions begin/g)).toHaveLength(1);
      expect(agents.match(/<!-- megamemory:instructions end -->/g)).toHaveLength(1);
    } finally {
      fs.rmSync(configDir, { force: true, recursive: true });
    }
  });
});
