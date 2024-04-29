import process from "process";
export async function timeItAsync<T>(promise: Promise<T>, label?: string): Promise<T> {
    const start = Date.now();
    const r = await promise;
    if (label) {
        console.debug(label, `took`, ((Date.now() - start) / 1e3).toFixed(2), `seconds`);
    }
    return r;
}

const CUMULATIVE_TIMES = {} as { [id: string]: { totalTime: number; totalCalls: number } };

export async function timeItCumulative<T>(id: string, promise: Promise<T>): Promise<T> {
    const start = Date.now();
    const r = await promise;
    const c = CUMULATIVE_TIMES[id] = CUMULATIVE_TIMES[id] ?? { totalCalls: 0, totalTime: 0 };
    ++c.totalCalls;
    const dt = Date.now() - start;
    console.debug(`${id} took ${(dt / 1e3).toFixed(2)} seconds`);
    c.totalTime += dt;
    return r;
}

export function timeItCumulativeSync<T>(id: string, cb: () => T): T {
    const start = Date.now();
    const r = cb();
    const c = CUMULATIVE_TIMES[id] = CUMULATIVE_TIMES[id] ?? { totalCalls: 0, totalTime: 0 };
    ++c.totalCalls;
    const dt = Date.now() - start;
    console.debug(`${id} took ${(dt / 1e3).toFixed(2)} seconds`);
    c.totalTime += dt;
    return r;
}

export function printCumulativeTimes(): void {
    console.debug(Object.entries(CUMULATIVE_TIMES)
        .map(([id, { totalCalls, totalTime }]) =>
            `total time of ${id}: ${(totalTime / 1e3).toFixed(1)}s (${totalCalls} calls)`
        ).join('\n'),
    );
}

process.on('exit', () => {
    printCumulativeTimes();
});