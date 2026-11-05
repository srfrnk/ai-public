# Filesystem Configuration: `filesystem.yaml`

The `filesystem.yaml` file defines which host files and directories may be accessed by the agent, whether they are read-only (`ro`) or read-write (`rw`), and which subtrees are strictly blacklisted.

---

## 1. File Location
```
~/.bantha/filesystem.yaml
```

---

## 2. Full Schema & Default Values

```yaml
version: "1.0"

mounts:
  # List of mount rules using unified Gitignore-style syntax
  rules:
    # Whitelisted workspaces (current directory is mounted rw by default)
    - "~/projects/**"

    # Specific blacklisted paths:
    # A leading '!' strictly denies access with absolute precedence.
    - "!~/projects/**/private-*"
    - "!~/projects/**/.git/config"
    - "!regex:^.*\\.pem$"
    - "!regex:^.*\\.key$"

    # System tools and libraries (read-only)
    - path: "/usr"
      mode: "ro"
    - path: "/lib"
      mode: "ro"
    - path: "/lib64"
      mode: "ro"
    - path: "/bin"
      mode: "ro"

  # Container sandbox home directory
  home:
    container_path: "/home/sandbox"
    mode: "rw"

  # Shared persistence hub and agent state configuration
  shared:
    hub:
      enabled: true
      mode: "rw"
      subdirs:
        rules: "rw"   # set to "ro" to prevent agent from modifying AGENTS.md
        mcp: "rw"     # set to "ro" to prevent agent from modifying servers.json
        skills: "rw"  # set to "ro" or "rw"
    agent_state:
      enabled: true
      mode: "rw"
```

---

## 3. How Blacklist Precedence & Recursive Masking Works

### 3.1 Kernel VFS Mount Masking (`tmpfs`)
When a whitelisted directory (e.g. `/workspace`) contains a blacklisted subfolder or file (e.g. `/workspace/private`):
1. Docker bind-mounts `/workspace` into the container namespace.
2. The `bantha` runner automatically mounts an empty, read-only `tmpfs` directly on top of the blacklisted path:
   ```bash
   --mount type=tmpfs,destination=/workspace/private,readonly
   ```
3. **Guaranteed Inaccessibility**: In the Linux kernel Virtual File System (VFS), a mounted filesystem takes precedence over the underlying directory. Even if a process inside the container traverses the filesystem tree (e.g., `find`, `ls -R`), the kernel intercepts path resolution at the mount point. The underlying host files are completely invisible and unwritable.

### 3.2 Hardcoded Ancestor Protections
To prevent configuration or host identity leaks:
- The configuration directory `~/.bantha`
- All parent/ancestor directories of `$HOME` (`/home/user`, `/home`, `/`)
- The source repository where `bantha` is installed
are **hardcoded as protected**. Any attempt to add them as a mount rule in `filesystem.yaml` triggers an immediate validation failure and halts container startup.
