# Install Babysitter-DV

This blueprint installs a project-local Babysitter-DV process that can drain ready Doc-Vader work items through the vanilla Babysitter surface.

## Dependencies

Reference install docs:

- [Node.js / npm](https://nodejs.org/en/download)
- [Babysitter](https://github.com/a5c-ai/babysitter/tree/main/packages/babysitter#readme)
- [Genty](https://github.com/a5c-ai/babysitter/tree/main/packages/genty/cli#readme)
- [Babysitter Pi plugin](https://github.com/a5c-ai/babysitter-pi#readme)
- [Pi](https://pi.dev/) / [Pi coding-agent package](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- [pnpm](https://pnpm.io/installation) for local/internal Doc-Vader installs

Install the Babysitter CLI, Genty, and the Pi Babysitter plugin globally:

```sh
npm install -g @a5c-ai/babysitter-sdk @a5c-ai/genty @a5c-ai/babysitter-pi
# Doc-Vader is the `dv` CLI. Install it from your Doc-Vader package/source, for example:
# pnpm install -g /path/to/doc-vader
command -v babysitter genty pi dv
```

Full Babysitter-DV installation notes, including the one-command script method and manual method: <https://github.com/calan-co/babysitter-dv/blob/main/docs/installation.md>.

Script method from a workspace:

```sh
curl -fsSL https://raw.githubusercontent.com/calan-co/babysitter-dv/main/scripts/install-babysitter-dv.sh \
  | sh -s -- --workspace "$PWD"
```

Use a local Babysitter Pi plugin checkout instead of the published package:

```sh
curl -fsSL https://raw.githubusercontent.com/calan-co/babysitter-dv/main/scripts/install-babysitter-dv.sh \
  | sh -s -- --workspace ~/dev/personal/chris-cald/dewey \
    --babysitter-pi-source ~/dev/upstream/a5c-ai/babysitter-pi
```

Manual Pi plugin step:

```sh
babysitter harness:install-plugin pi --workspace "$PWD" --json
```

## Install this blueprint into a workspace

Important: `babysitter blueprints:install` prints these instructions and returns a `processFile`; it does not mutate the workspace by itself. Execute the returned install process to write the `.a5c/` files.

```sh
babysitter blueprints:add-marketplace \
  --marketplace-url https://github.com/calan-co/babysitter-dv.git \
  --project \
  --json

INSTALL_JSON=$(babysitter blueprints:install --plugin-name babysitter-dv --project --json)
PROCESS_FILE=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0,"utf8")).processFile)' <<EOF_JSON
$INSTALL_JSON
EOF_JSON
)
printf '{"dir":"%s","yes":true,"force":true}\n' "$PWD" > /tmp/babysitter-dv-install-inputs.json
RUN_JSON=$(babysitter run:create \
  --process-id babysitter-dv/install \
  --entry "$PROCESS_FILE#process" \
  --inputs /tmp/babysitter-dv-install-inputs.json \
  --non-interactive \
  --json)
RUN_DIR=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0,"utf8")).runDir)' <<EOF_JSON
$RUN_JSON
EOF_JSON
)
babysitter run:iterate "$RUN_DIR" --json
```

Use `force:true` when reinstalling so stale generated process files are refreshed.

For local development in the Babysitter-DV repository, the compatibility wrapper runs the same install process directly:

```sh
npm run workspace:init -- --dir /path/to/workspace --yes --force
```

After install, run from Pi:

```text
/babysitter:call systematically work through the ready DV backlog using the project Babysitter-DV process
```

The install process writes `.a5c/processes/babysitter-dv.js`, `.a5c/processes/babysitter-dv/`, and blueprint documentation under `.a5c/blueprints/babysitter-dv/`.

No `ports.mjs` is required. If an old `.a5c/processes/babysitter-dv/ports.mjs` stub exists, delete it after reinstall.
