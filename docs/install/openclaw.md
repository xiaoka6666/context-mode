# Install context-mode v2 on OpenClaw

## Install

```sh
npm i -g context-mode
context-mode setup --agents openclaw
```

Update:

```sh
context-mode upgrade
```

Check: `context-mode doctor`

OpenClaw loads context-mode from its own extension directory, so setup writes one host config entry and the rest comes from the installed package. `npm i -g context-mode` also gives the `context-mode` command for doctor.

With no terminal (a script or CI), add `--yes`: `context-mode setup --yes --agents openclaw`. Without it, setup stops with exit 2.

Restart the OpenClaw gateway after setup.

To do the setup step by hand, run `context-mode setup --print openclaw` and follow what it prints.

## What setup changes

- Adds the `context-mode` entry to `~/.openclaw/openclaw.json` under `mcp.servers`. Other servers stay.
- The in-process plugin file `openclaw/plugin.js` ships inside the installed package. OpenClaw loads it from `~/.openclaw/extensions/context-mode/`, and that entry's event handlers run the session_start, prompt, tool_call and tool_result hooks. The `ctx_*` tools come with the plugin, so the hooks and the tools load together.
- Writes the skills `/ctx-doctor`, `/ctx-stats` and `/ctx-upgrade` to the package's own skills directory, which OpenClaw loads with the plugin.
- Backs up each file it writes first. A failed step is rolled back byte for byte.
- Never edits `CLAUDE.md`, `AGENTS.md` or other instruction files.

## Verify

```sh
context-mode doctor --agents openclaw
```

Inside OpenClaw, call the `ctx_doctor` tool or run `/ctx-doctor`. It prints `agent openclaw`.

## Remove

```sh
context-mode setup --remove --agents openclaw
```

It puts each touched file back. To remove the package too, see [Uninstall](./README.md#uninstall).

## Known limits

- OpenClaw runs the plugin inside the gateway process, so a hook pays no `node` start.
- The doctor's hook round trip sends one payload and checks the reply shape; it does not time it, because no `node` is started.
- Restart the gateway after setup so the new extension entry loads.

## Report a problem

Run `context-mode doctor --agents openclaw`, or call `ctx_doctor` inside OpenClaw. A failed check prints a `gh issue create` command and a report file under `~/.context-mode/reports/`. Open the [v2 bug form](https://github.com/mksglu/context-mode/issues/new?template=bug.yml) and paste the report.
