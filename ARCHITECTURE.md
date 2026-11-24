# pragmatic-host-agent architecture

| File | Role |
|---|---|
| `src/bin/pragmatic-host-agentd.ts` | The entry: `HostAgentMain.Run(process.env)`, a failed start logged and exit 1. |
| `src/host-agent-main.ts` | `HostAgentMain`: settings, the trust root file, the host key, the enrolment (retried while the platform is unavailable, any refusal stops the start), then the wiring of `HostAgentLoop` (kind driver, helm, kubectl, the vendored ingress manifest). |
| `src/host-agent-loop.ts` | `HostAgentLoop`: two `RepeatingTask`s (one pass at a time each): the capacity report every 30 s on its own, and the placement work every 30 s (pull, start the placements' runs in the background, pending results, due credential rotations), each stage guarded and logged by its message. |
| `src/host-agent-component.ts` | `HostAgentComponent`: the component descriptor (option `core`: the `PRAGMATIC_HOST_*` settings and their defaults; no port, no storage). |
| `src/release-components.ts` | `Components`: the descriptor source the image build reads. |
| `src/settings/` | `HostSettings` (every setting checked at start; `HostSettingsError` names each missing or wrong one, the start-smoke refusal), `PortRange`. |
| `src/state/` | `StateFiles`: the state directory's files, written whole (temp file, rename), mode 0600/0700; `StateLock`: one agent per state directory (`agent.lock`: instance id, pid, heartbeat; created O_EXCL, taken over only when stale; a second agent refuses to start). |
| `src/identity/` | `HostIdentity`: the machine's Ed25519 key in `host-key.pem`, created once, never replaced or logged. |
| `src/enrolment/` | `HostEnrolment` (the self-signed `HostEnrolmentRequest` over `HttpAgentChannel`, `EnrolmentHandshake.AcceptHost` with the pinned root, refusals mapped to `HostEnrolmentFailure`; `EnsureEnrolled` reads the code only while not enrolled), `HostEnrolmentStore` (`enrolment.json`; the pinned root always wins). |
| `src/channel/` | `HostChannel`: every message signed as `Participant.Host(HostId)`, every platform message verified against the adopted root and addressed to this host; pulls (`Pull`/`PullBatch`) and placement items. |
| `src/report/` | `CapacityReporter` (`HostReport`: capacity, allocatable, free hive slots, placement states), `DockerMachineProbe` (`docker info`, `/proc/meminfo`, statfs of the state dir). |
| `src/placement/` | `PlacementPuller` (each pulled item verified, recorded, then the cursor stored), `PlacementReconciler` (Place: `cluster` -> `engine` -> `enrolment` -> `credential` -> `placed`, each step recorded before the next; upgrade = helm only; Remove; bounded retries then failed with the cluster deleted; the enrolment checked once per pass until a recorded deadline; placements run concurrently, one run per placement, slots and ports taken under one lock; placement versions only rise (an older or the same version changes nothing); results carry the version and are kept until acknowledged, then a finished placement is pruned; 3-day credential rotation, the rotation number claimed before each handover), `PlacementRecord`, `PlacementStore` (`placements/<id>.json`, `placement-cursor.json`, `placement-tombstones.json`; an unreadable file is skipped and reported failed). The puller stores the cursor only when every item of the batch was taken. |
| `src/cluster/` | `IClusterDriver`, `ClusterSpec`, `ClusterNames` (`pragmatic-hosted-<id>`); `KindClusterDriver` (kind create/export/delete, the vendored ingress-nginx as the default IngressClass, kind's `standard` StorageClass kept); `KindClusterConfig` (the kind config: API server on 127.0.0.1:<port>, the pinned `kindest/node` v1.37.0 by digest, JSON 6902 patches appending the mesh SAN and each `ApiServerExtraArgs` flag); `PortAllocator` (16444-16463, a port per active placement, a port something else listens on skipped). |
| `src/engine/` | `EngineInstaller`: `WriteCode` (the code Secret on stdin), `helm pull` checked against the chart digest, `helm upgrade --install` with the hosted values (console.host and console.baseDomain = the hive host name); `Upgrade` helm `--atomic` only; `Forget` (the charts of a removed cluster). |
| `src/credential/` | `ClusterCredentialIssuer`: ServiceAccount `pragmatic-system/pragmatic-platform` bound to cluster-admin, a 7-day TokenRequest, the kubeconfig at the mesh address, sealed `ClusterCredentialHandover` (<= 64 KiB). |
| `src/kube/` | `IHostedKube` / `KubectlHostedKube`: apply on stdin, ConfigMap existence, `create token`, the cluster CA. |
| `src/process/` | `IProcessRunner` (argument vectors only, never a shell; secrets on standard input; every run killed at its deadline), `NodeProcessRunner` (over an `ISpawner`), `CheckedRunner`, `IDelay`. |
| `vendor/ingress-nginx/deploy.yaml` | ingress-nginx's kind manifest at controller-v1.15.1, vendored unchanged (images by digest). |
| `closure.json` | What the image copies; `pragmatic-closure-check` keeps it, the Dockerfile and the code in step. |

Tests: next to each folder in `tests/` (fakes in `src/tests/fakes.ts` and `src/placement/tests/placement-fixture.ts`: a
fake cluster driver, a fake kube, a fake process runner as helm and kind with exact argument vectors, the protocol's
`FakePlatform`), and `tests/` (the release module's descriptor equals its golden digest; no TODL, Mural or todl-runtime
dependency).

`src/release-components.ts` keeps its module-level `Components` export: the toolkit's `pragmatic-component-descriptors`
reads that export by name (`--components dist/release-components.js`).
