# pragmatic-host-agent

The host agent (`pragmatic-host-agentd`, image `ghcr.io/pragmatic-tech-ai/pragmatic-host-agent`, release app 10). It runs on
one of our hosting machines and places Hosted hives there (C5.1): it enrols the machine once with a one-time code from
the platform admin console, reports the machine's capacity every 30 s, pulls the placements the platform schedules onto
it, and for each one creates a kind cluster, installs the engine chart with the hive's one-time code, hands the platform
a sealed, rotating cluster credential over the mesh, and removes it all again when the customer leaves.

It stays dependency-light: node built-ins, `pragmatic-hive-protocol` (the agent channel's messages and their
verification), `pragmatic-component` and `pragmatic-observability`; no TODL, Mural or todl-runtime
(`tests/package-deps.test.ts`). `kind`, `helm` 3, `kubectl` and the docker CLI come pinned in the image.

## Running it

The container runs on the machine with host networking, the Docker socket and its state directory mounted, as a user
that may use the socket:

    docker run -d --name pragmatic-host-agent --restart unless-stopped --network host \
      -v /var/run/docker.sock:/var/run/docker.sock --group-add "$(stat -c %g /var/run/docker.sock)" \
      -v /var/lib/pragmatic-host-agent:/var/lib/pragmatic-host-agent \
      -v /etc/pragmatic-host-agent:/etc/pragmatic-host-agent:ro \
      -e PRAGMATIC_HOST_MACHINE_NAME=hive-laptop -e PRAGMATIC_HOST_MESH_ADDRESS=<mesh address> \
      -e PRAGMATIC_HOST_TRUST_ROOT_FILE=/etc/pragmatic-host-agent/platform-signing-key.pub \
      -e PRAGMATIC_HOST_ENROLMENT_CODE_FILE=/etc/pragmatic-host-agent/enrolment-code \
      ghcr.io/pragmatic-tech-ai/pragmatic-host-agent@sha256:<digest>

The state directory must be writable by uid 10001 (the image's user). The API-server ports (16444-16463 by default)
are bound on 127.0.0.1; the machine forwards them from its mesh address (on hive-laptop a Windows port proxy).

## Configuration

`PRAGMATIC_HOST_MACHINE_NAME`, `PRAGMATIC_HOST_MESH_ADDRESS`, `PRAGMATIC_HOST_TRUST_ROOT_FILE` (the published
`frontdoor/platform-admin/platform-signing-key.pub`) are required; `PRAGMATIC_HOST_STATE_DIR` (default
`/var/lib/pragmatic-host-agent`), `PRAGMATIC_HOST_CHANNEL_URL` (default `https://agent.pragmatic-tech.ai`),
`PRAGMATIC_HOST_HIVE_SLOTS` (default 4), `PRAGMATIC_HOST_PORT_RANGE` (default `16444-16463`) and
`PRAGMATIC_HOST_ENROLMENT_CODE_FILE` (the one-time code, read only while the machine is not enrolled). Started with none
of them the agent stops with `the host agent is not configured: ...` naming each missing one.

The state directory holds the host key (`host-key.pem`, PKCS#8, mode 0600, never replaced), the enrolment
(`enrolment.json`: host id, channel, the platform's public signing and sealing keys), the placements
(`placements/<id>.json`, each step recorded), the pull cursor and each cluster's kind config and admin kubeconfig. It
never holds a platform secret; a hosted hive's one-time code stays in its placement record only until it is written into
the cluster.

## Development

Packages come from GitHub Packages (`@pragmatic-tech-ai` scope, `.npmrc` reads the token from `NODE_AUTH_TOKEN`).

    npm ci
    npm run build
    npm test
    npm run typecheck
    npx pragmatic-closure-check

The image is built from `Dockerfile` with `docker-bake.hcl` in two steps (the header of either file shows the commands).
CI and the image release (tag `v<version>`, equal to `package.json`'s version) run pragmatic-shared's reusable container
workflows. The build files are rendered by `pragmatic-container-template` (`@pragmatic-tech-ai/pragmatic-release-toolkit`):

    npx pragmatic-container-template render --out .

`vendor/ingress-nginx/deploy.yaml` is ingress-nginx's kind manifest at `controller-v1.15.1`
(`deploy/static/provider/kind/deploy.yaml`, images by digest, sha256
`2a3ae008c8786431115502644e77ab398fdebfb721a5d1195ed3089cde3299df`), unchanged; a new version replaces the file whole.
