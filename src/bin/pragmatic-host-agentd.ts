import { HostAgentMain } from '../host-agent-main.js'

await HostAgentMain.Run(process.env).catch(HostAgentMain.Fail)
