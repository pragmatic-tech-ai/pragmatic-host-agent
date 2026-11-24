# pragmatic-host-agent architecture

| File | Role |
|---|---|
| `src/bin/pragmatic-host-agentd.ts` | The entry: `HostAgentMain.Run(process.env)`, a failed start logged and exit 1. |
| `src/host-agent-main.ts` | `HostAgentMain`: settings, the trust root file, the host key, the enrolment (retried while the platform is unavailable, any refusal stops the start), then the wiring of `HostAgentLoop`. |
| `src/host-agent-loop.ts` | `HostAgentLoop`: the capacity report every 30 s (`RepeatingTask`: one pass at a time). |
| `src/host-agent-component.ts` | `HostAgentComponent`: the component descriptor (option `core`: the `PRAGMATIC_HOST_*` settings and their defaults; no port, no storage). |
| `src/release-components.ts` | `Components`: the descriptor source the image build reads. |
| `src/settings/` | `HostSettings` (every setting checked at start; `HostSettingsError` names each missing or wrong one, the start-smoke refusal), `PortRange`. |
| `src/state/` | `StateFiles`: the state directory's files, written whole (temp file, rename), mode 0600/0700. |
| `src/identity/` | `HostIdentity`: the machine's Ed25519 key in `host-key.pem`, created once, never replaced or logged. |
| `src/enrolment/` | `HostEnrolment` (the self-signed `HostEnrolmentRequest` over `HttpAgentChannel`, `EnrolmentHandshake.AcceptHost` with the pinned root, refusals mapped to `HostEnrolmentFailure`; `EnsureEnrolled` reads the code only while not enrolled), `HostEnrolmentStore` (`enrolment.json`; the pinned root always wins). |
| `src/channel/` | `HostChannel`: every message signed as `Participant.Host(HostId)`, every platform message verified against the adopted root and addressed to this host; pulls (`Pull`/`PullBatch`) and placement items. |
| `src/report/` | `CapacityReporter` (`HostReport`: capacity, allocatable, free hive slots, placement states), `DockerMachineProbe` (`docker info`, `/proc/meminfo`, statfs of the state dir). |
| `src/placement/` | `PlacementRecord` (one placement's recorded step), `PlacementStore` (`placements/<id>.json`, the pull cursor). |
| `src/process/` | `IProcessRunner` (argument vectors only, never a shell; secrets on standard input), `NodeProcessRunner`, `CheckedRunner`. |
| `vendor/ingress-nginx/deploy.yaml` | ingress-nginx's kind manifest at controller-v1.15.1, vendored unchanged (images by digest). |
| `closure.json` | What the image copies; `pragmatic-closure-check` keeps it, the Dockerfile and the code in step. |

Tests: next to each folder in `tests/` (fakes in `src/tests/fakes.ts`, the protocol's `FakePlatform` for enrolment), and
`tests/` (the release module's descriptor equals its golden digest; no TODL, Mural or todl-runtime dependency).
