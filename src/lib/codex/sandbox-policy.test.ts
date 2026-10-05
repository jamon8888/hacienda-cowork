import { describe, expect, test } from "bun:test";

import {
  buildCodexWorkspacePermissionSelection,
  WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID,
} from "./sandbox-policy";

describe("OIX workspace-only permission profiles", () => {
  test("uses a named write profile and explicit runtime workspace root", () => {
    const selection = buildCodexWorkspacePermissionSelection({
      sandboxMode: "workspace-write",
      readAccessMode: "workspace-only",
      networkAccess: false,
      allowTempAccess: false,
      cwd: "/workspace/project",
    });

    expect(selection).not.toBeNull();
    expect(selection?.permissionProfileId).toBe(WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID);
    expect(selection?.runtimeWorkspaceRoots).toEqual(["/workspace/project"]);
    expect(selection?.config).toEqual({
      permissions: {
        [WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID]: {
          filesystem: {
            ":minimal": "read",
            ":workspace_roots": {
              ".": "write",
            },
          },
          network: {
            enabled: false,
          },
        },
      },
    });
  });

  test("keeps a read-only workspace read-only and can allow temp reads", () => {
    const selection = buildCodexWorkspacePermissionSelection({
      sandboxMode: "read-only",
      readAccessMode: "workspace-only",
      networkAccess: true,
      allowTempAccess: true,
      cwd: "/workspace/project",
      additionalReadableRoots: ["/runtime/interpreter-cli", "  ", "/runtime/interpreter-cli"],
      additionalWritableRoots: ["/runtime/interpreter-cli/bridge"],
    });

    expect(selection?.config).toEqual({
      permissions: {
        [WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID]: {
          filesystem: {
            ":minimal": "read",
            ":workspace_roots": {
              ".": "read",
            },
            ":tmpdir": "read",
            "/runtime/interpreter-cli": "read",
            "/runtime/interpreter-cli/bridge": "write",
          },
          network: {
            enabled: true,
          },
        },
      },
    });
  });

  test("uses the stable sandbox contract when full-system reads are allowed", () => {
    expect(buildCodexWorkspacePermissionSelection({
      sandboxMode: "workspace-write",
      readAccessMode: "full-system",
      networkAccess: true,
      cwd: "/workspace/project",
    })).toBeNull();
  });

  test("confines a Safe workspace: mirror read-only, drafts and scratch writable", () => {
    const selection = buildCodexWorkspacePermissionSelection({
      sandboxMode: "danger-full-access",
      readAccessMode: "full-system",
      networkAccess: true,
      allowTempAccess: true,
      cwd: "/workspace/project/safe",
      additionalReadableRoots: ["/runtime/interpreter-cli"],
      additionalWritableRoots: ["/runtime/interpreter-cli/bridge"],
      safe: {
        safeRoot: "/workspace/project/safe",
        draftsRoot: "/workspace/project/safe/_drafts",
        readableRoots: ["/home/u/.openinterpreter/skills", " "],
      },
    });

    expect(selection?.runtimeWorkspaceRoots).toEqual(["/workspace/project/safe"]);
    expect(selection?.threadConfig).toEqual({ project_doc_max_bytes: 0 });
    expect(selection?.config).toEqual({
      permissions: {
        [WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID]: {
          filesystem: {
            ":minimal": "read",
            ":workspace_roots": { ".": "read" },
            ":tmpdir": "write",
            "/runtime/interpreter-cli": "read",
            "/runtime/interpreter-cli/bridge": "write",
            "/home/u/.openinterpreter/skills": "read",
            "/workspace/project/safe/_drafts": "write",
          },
          network: { enabled: true },
        },
      },
    });
  });

  test("adds no thread config outside a Safe workspace", () => {
    const selection = buildCodexWorkspacePermissionSelection({
      sandboxMode: "workspace-write",
      readAccessMode: "workspace-only",
      networkAccess: false,
      cwd: "/workspace/project",
    });
    expect(selection?.threadConfig).toBeUndefined();
  });
});

