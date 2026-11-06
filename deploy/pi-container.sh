#!/usr/bin/env bash
# Launcher for one ticket's Pi worker: a fresh rootless Podman container per assignment.
#
# The runtime invokes this as `pi-container.sh <pi args...>` and supplies, per ticket:
#   PI_CODING_AGENT_DIR  stateDir/pi-config/<ticketId>   (holds models.json and mcp.json, already written)
#   SA_TICKET_TOKEN      this assignment's bearer token, valid for the gateway and the MCP endpoint
#   SA_MCP_URL           worker MCP endpoint URL
#   SA_GATEWAY_URL       model gateway URL
#
# The container is ephemeral (`--rm`), capped, and gets only the ticket's own workspace plus its Pi config directory.
set -euo pipefail

: "${PI_CODING_AGENT_DIR:?PI_CODING_AGENT_DIR is not set}"
: "${SA_TICKET_TOKEN:?SA_TICKET_TOKEN is not set}"

IMAGE="${SA_PI_IMAGE:-localhost/superagent-pi:1.5.0}"
WORKSPACE_ROOT="${SA_WORKSPACE_ROOT:-$HOME/superagent-workspaces}"
CPUS="${SA_PI_CPUS:-2}"
MEMORY="${SA_PI_MEMORY:-6g}"

# The runtime names the config directory after the ticket, so its basename is the ticket id.
TICKET_ID="$(basename "$PI_CODING_AGENT_DIR")"
# Workspaces hold a worker's files; keep them private to the operator even when an older run created them.
mkdir -p -m 700 "$WORKSPACE_ROOT"
chmod 700 "$WORKSPACE_ROOT"
WORKSPACE="$WORKSPACE_ROOT/$TICKET_ID"
mkdir -p -m 700 "$WORKSPACE"
chmod 700 "$WORKSPACE"

# Network: pasta gives the worker its own network namespace with internet access. Only the gateway and MCP ports are
# forwarded from the container's loopback to the host's (`-T`), so the 127.0.0.1 URLs in models.json / mcp.json keep
# working while every other host loopback service (admin console, control port, local proxies) stays unreachable.
# `--no-map-gw` stops the container from reaching the host through the gateway address. SA_PI_NETWORK overrides it.
port_of() {
  local rest="${1#*://}"
  rest="${rest%%/*}"
  local port="${rest##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || { echo "pi-container.sh: no port in $1" >&2; exit 2; }
  echo "$port"
}
: "${SA_GATEWAY_URL:?SA_GATEWAY_URL is not set}"
: "${SA_MCP_URL:?SA_MCP_URL is not set}"
GATEWAY_PORT="$(port_of "$SA_GATEWAY_URL")"
MCP_PORT="$(port_of "$SA_MCP_URL")"
# Web previews run inside the container and are reached from the host, the opposite direction of the gateway and MCP
# forwards. pasta's `-t 127.0.0.1/<port>` binds the host's loopback and forwards into the container, so a preview is
# reachable through the admin proxy but never from the LAN. SA_PREVIEW_PORTS is a comma list from the runtime; only
# integers in the allowed range are used, and SA_PI_NETWORK still overrides the whole network specification.
PASTA_OPTIONS="--no-map-gw,-T,$GATEWAY_PORT,-T,$MCP_PORT"
PREVIEW_ENV=()
if [[ -n "${SA_PREVIEW_PORTS:-}" ]]; then
  PREVIEW_FORWARD=0
  IFS=',' read -r -a PREVIEW_LIST <<< "$SA_PREVIEW_PORTS"
  for preview_port in "${PREVIEW_LIST[@]}"; do
    [[ "$preview_port" =~ ^[0-9]+$ ]] || continue
    (( preview_port >= 1024 && preview_port <= 65535 )) || continue
    PASTA_OPTIONS+=",-t,127.0.0.1/$preview_port"
    PREVIEW_FORWARD=1
  done
  if (( PREVIEW_FORWARD == 1 )); then
    PREVIEW_ENV=(--env SA_PREVIEW_PORTS)
  fi
fi
NETWORK="${SA_PI_NETWORK:-pasta:$PASTA_OPTIONS}"

# Secrets granted to this ticket: the runtime exports each value and lists the names in SA_SECRET_NAMES. Only names that
# look like environment variables are forwarded; the value comes from this process's environment, never from a file.
SECRET_ENV=()
if [[ -n "${SA_SECRET_NAMES:-}" ]]; then
  IFS=',' read -r -a SECRET_LIST <<< "$SA_SECRET_NAMES"
  for secret_name in "${SECRET_LIST[@]}"; do
    [[ "$secret_name" =~ ^[A-Z][A-Z0-9_]{0,63}$ ]] || continue
    SECRET_ENV+=(--env "$secret_name")
  done
fi

exec podman run \
  --rm \
  --replace \
  --interactive \
  --name "sa-$TICKET_ID" \
  --userns=keep-id \
  --network="$NETWORK" \
  --cpus="$CPUS" \
  --memory="$MEMORY" \
  --pids-limit=512 \
  --security-opt=no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,size=256m \
  --tmpfs /home/node:rw,size=64m \
  --volume "$WORKSPACE:/workspace:rw" \
  --volume "$PI_CODING_AGENT_DIR:/pi-config:rw" \
  --workdir /workspace \
  --env PI_CODING_AGENT_DIR=/pi-config \
  --env PI_TELEMETRY=0 \
  --env PI_OFFLINE=1 \
  --env SA_TICKET_TOKEN \
  --env SA_MCP_URL \
  --env SA_GATEWAY_URL \
  "${SECRET_ENV[@]}" \
  "${PREVIEW_ENV[@]}" \
  "$IMAGE" \
  pi \
  "$@"
