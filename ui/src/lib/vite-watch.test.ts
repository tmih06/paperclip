import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite-plus";
import { createUiDevWatchOptions, shouldIgnoreUiDevWatchPath } from "./vite-watch";

describe("shouldIgnoreUiDevWatchPath", () => {
  it("ignores test-only files and folders", () => {
    expect(shouldIgnoreUiDevWatchPath("/repo/ui/src/components/IssuesList.test.tsx")).toBe(true);
    expect(shouldIgnoreUiDevWatchPath("/repo/ui/src/lib/issue-tree.spec.ts")).toBe(true);
    expect(shouldIgnoreUiDevWatchPath("/repo/ui/src/__tests__/helpers.ts")).toBe(true);
    expect(shouldIgnoreUiDevWatchPath("/repo/ui/tests/helpers.ts")).toBe(true);
  });

  it("keeps runtime source files watchable", () => {
    expect(shouldIgnoreUiDevWatchPath("/repo/ui/src/components/IssuesList.tsx")).toBe(false);
    expect(shouldIgnoreUiDevWatchPath("/repo/ui/src/pages/IssueDetail.tsx")).toBe(false);
  });
});

describe("createUiDevWatchOptions", () => {
  it("preserves the WSL /mnt polling fallback", () => {
    expect(createUiDevWatchOptions("/mnt/c/paperclip")).toMatchObject({
      usePolling: true,
      interval: 1000,
    });
  });

  it("observes a source change followed immediately by restoring the original content", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-ui-watch-"));
    const source = join(root, "module.ts");
    await writeFile(source, "original");
    const server = await createServer({
      configFile: false,
      root,
      server: { watch: createUiDevWatchOptions(root) },
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await vi.waitFor(() => {
        expect(Object.values(server.watcher.getWatched()).flat()).toContain("module.ts");
      });
      const observed: string[] = [];
      const restored = new Promise<void>((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Source restoration was not observed")), 1500);
        server.watcher.on("change", async file => {
          if (file !== source) return;
          try {
            const value = await readFile(source, "utf8");
            if (observed.at(-1) === value) return;
            observed.push(value);
            if (value === "changed") await writeFile(source, "original");
            else if (value === "original") resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      await writeFile(source, "changed");
      await restored;
      expect(observed).toEqual(["changed", "original"]);
    } finally {
      clearTimeout(deadline);
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("always includes the ignored-path predicate", () => {
    expect(createUiDevWatchOptions("/Users/dotta/paperclip")).toHaveProperty("ignored");
  });
});
