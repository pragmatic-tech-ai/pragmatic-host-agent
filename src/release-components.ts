import { ContainerComponentSource, ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { HostAgentComponent } from './host-agent-component.js'

/** This repository's one component, for `pragmatic-component-descriptors --components dist/release-components.js`. */
export const Components = new ContainerComponentSource(ReleaseApp.HostAgent, () => HostAgentComponent.Descriptor())
