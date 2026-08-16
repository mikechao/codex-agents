#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /absolute/path/to/target-repository" >&2
  exit 2
fi

project_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=$(CDPATH= cd -- "$1" && pwd)

git -C "$target" rev-parse --show-toplevel >/dev/null 2>&1 || {
  echo "Target is not a Git repository: $target" >&2
  exit 1
}

if [ -e "$target/.codex/agents" ]; then
  echo "Refusing to replace existing agent definitions: $target/.codex/agents" >&2
  exit 1
fi

config="$target/.codex/config.toml"
if [ -f "$config" ] && grep -q '^\[mcp_servers\.workflow_state\]$' "$config"; then
  echo "Refusing to replace existing workflow_state registration: $config" >&2
  exit 1
fi

case "$project_root" in
  *"'"* | *"
"*)
    echo "Project path cannot be represented safely in TOML: $project_root" >&2
    exit 1
    ;;
esac

if [ ! -f "$project_root/.codex/workflow-mcp/dist/server.js" ]; then
  echo "Compiled server artifact missing: $project_root/.codex/workflow-mcp/dist/server.js" >&2
  echo "Run 'pnpm build' in $project_root first." >&2
  exit 1
fi
if [ ! -f "$project_root/.codex/agents/dist/change-receipt.js" ]; then
  echo "Compiled receipt artifact missing: $project_root/.codex/agents/dist/change-receipt.js" >&2
  echo "Run 'pnpm build' in $project_root first." >&2
  exit 1
fi
for file in code_reviewer.toml committer.toml implementer.toml WORKFLOW.md; do
  if [ ! -f "$project_root/.codex/agents/$file" ]; then
    echo "Required agent definition missing: $project_root/.codex/agents/$file" >&2
    exit 1
  fi
done

mkdir -p -- "$target/.codex"
agents_staging=$(mktemp -d "$target/.codex/.agents.install.XXXXXX")
config_staging=$(mktemp "$target/.codex/.config.install.XXXXXX")
cleanup() {
  rm -rf -- "$agents_staging"
  rm -f -- "$config_staging"
}
trap cleanup EXIT HUP INT TERM

mkdir -p -- "$agents_staging/dist"
for file in code_reviewer.toml committer.toml implementer.toml WORKFLOW.md EVALS.md EVAL_RESULTS.md; do
  if [ -f "$project_root/.codex/agents/$file" ]; then
    cp -- "$project_root/.codex/agents/$file" "$agents_staging/"
  fi
done
cp -- "$project_root/.codex/agents/dist/change-receipt.js" "$agents_staging/dist/"

if [ -f "$config" ]; then
  cp -- "$config" "$config_staging"
  printf '\n' >>"$config_staging"
fi

cat >>"$config_staging" <<EOF_CONFIG
# Local durable state for the reusable custom-agent workflow.
[mcp_servers.workflow_state]
command = "node"
args = ["--no-warnings", '$project_root/.codex/workflow-mcp/dist/server.js']
startup_timeout_sec = 10
tool_timeout_sec = 30
required = false
default_tools_approval_mode = "prompt"
EOF_CONFIG

mv -- "$agents_staging" "$target/.codex/agents"
mv -- "$config_staging" "$config"
trap - EXIT HUP INT TERM

echo "Installed Codex agents and workflow_state MCP registration into: $target"
echo "Restart or reload Codex, then run: codex mcp get workflow_state"
