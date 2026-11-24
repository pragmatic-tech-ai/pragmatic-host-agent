/** Waits a while (the enrolment retry); faked in tests. */
export interface IDelay
{
    Wait(ms: number): Promise<void>
}

export class TimerDelay implements IDelay
{
    public Wait(ms: number): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}
