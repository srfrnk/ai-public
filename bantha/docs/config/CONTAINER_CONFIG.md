# Container Runtime Configuration: `container.yaml`

The `container.yaml` file controls the Docker container runtime parameters, resource limits, process capabilities, and user mappings.

---

## 1. File Location
```
~/.bantha/container.yaml
```

---

## 2. Full Schema & Default Values

```yaml
version: "1.0"
image: "bantha:latest"

runtime:
  # Maximum memory allocated to the agent container (e.g., '16g', '8g', '512m')
  memory_limit: "16g"

  # Maximum CPU cores allocated to the agent container (e.g., 8.0, 4.0)
  cpu_limit: 8.0

  # When true, runs container process with the host user's UID and GID
  run_as_user: true

  # Working directory inside container.
  # 'auto' maps host current working directory if it is permitted under filesystem rules.
  workdir: "auto"

  # Linux capabilities granted to the container.
  # NET_ADMIN is required for netfilter (iptables) firewall rules inside the container network namespace.
  cap_add:
    - "NET_ADMIN"

  # Security options passed to docker run
  security_opts:
    - "no-new-privileges:true"
```

---

## 3. Options Reference

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `version` | string | `"1.0"` | Configuration schema version. |
| `image` | string | `"bantha:latest"` | Name of the Docker image to execute. |
| `runtime.memory_limit` | string | `"16g"` | Hard memory ceiling enforced by Linux cgroups. |
| `runtime.cpu_limit` | float | `8.0` | Maximum CPU core quota enforced by Linux cgroups. |
| `runtime.run_as_user` | boolean | `true` | Maps host user `UID:GID` so file edits inside the container retain proper ownership on the host. |
| `runtime.workdir` | string | `"auto"` | Initial working directory. |
| `runtime.cap_add` | list | `["NET_ADMIN"]` | Linux capabilities added to container namespace. |
| `runtime.security_opts`| list | `["no-new-privileges:true"]`| Prevents container sub-processes from gaining additional privileges. |
